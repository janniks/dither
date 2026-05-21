import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile, mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { binDir } from "./home";
import { acquire, release } from "./locks";

/**
 * Dither owns its Deno. On first need, we download a pinned release from the
 * official GitHub URL, sha256-verify it against a hash hard-coded here, and
 * install it at `<DITHER_DIR>/bin/deno-<version>`. Plugin runs spawn from
 * that exact path. The single managed-binary path is the durable FDA target
 * on macOS — see `tcc-hint.ts` and `specs/managed-deno.md`.
 *
 * Bumping Deno is a single PR that updates `VERSION` and every supported
 * row of `HASHES`. Hashes are computed on a trusted machine and attested in
 * the PR; the release-side `.sha256sum` file is not trusted (compromised by
 * the same vector that would compromise the binary).
 */

const VERSION = "2.7.13";

type Target =
  | "aarch64-apple-darwin"
  | "x86_64-apple-darwin"
  | "x86_64-unknown-linux-gnu"
  | "aarch64-unknown-linux-gnu";

const HASHES: Record<Target, string> = {
  "aarch64-apple-darwin": "e2e63288d11e3f36855b60d77585844cbc5146600cbc7224e2d9276a35378089",
  "x86_64-apple-darwin": "b4153bee3c24074c83513e1a209ffc982277f88b184caccd4de9ba5113cfa2e5",
  "x86_64-unknown-linux-gnu": "d7b452de2578742889b70a7e3cf90eb14b8e6b1bca4758380da3630d694f04ff",
  "aarch64-unknown-linux-gnu": "c017fa8389bd96b6b07b3416bdb8d37074ab2ff1c83a9c94f7b2a6a7da026dac",
};

const overrideHashes: Partial<Record<Target, string>> = {};

/** Test hook: override the expected hash for the active target so tests can
 *  exercise the full install pipeline with a generated zip. */
export function setHashOverride(target: Target, hash: string | null): void {
  if (hash === null) delete overrideHashes[target];
  else overrideHashes[target] = hash;
}

export function detectTarget(): Target {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(
    `dither: managed Deno is not supported on ${p}/${a}. ` +
      `Set DITHER_USE_SYSTEM_DENO=1 to use a Deno on PATH instead.`,
  );
}

function downloadUrl(target: Target): string {
  return `https://github.com/denoland/deno/releases/download/v${VERSION}/deno-${target}.zip`;
}

export function managedDenoPath(): string {
  return join(binDir(), `deno-${VERSION}`);
}

/** Swappable for tests; returns the raw zip bytes for a given URL. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const body = res.body;
  if (!body) return new Uint8Array(await res.arrayBuffer());

  const tty = process.stderr.isTTY;
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastDraw = 0;
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const now = Date.now();
    if (tty && now - lastDraw > 100) {
      lastDraw = now;
      drawProgress(received, total);
    }
  }
  if (tty) {
    drawProgress(received, total);
    process.stderr.write("\n");
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};

function drawProgress(received: number, total: number): void {
  const mb = (received / 1_048_576).toFixed(1);
  if (total > 0) {
    const pct = Math.min(100, Math.floor((received / total) * 100));
    const totalMb = (total / 1_048_576).toFixed(1);
    const width = 24;
    const filled = Math.floor((pct / 100) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    process.stderr.write(`\rdither: ${bar} ${pct}% (${mb}/${totalMb} MB)`);
    return;
  }
  process.stderr.write(`\rdither: downloaded ${mb} MB`);
}

let fetcher: Fetcher = defaultFetcher;

/** Test hook: replace the network fetcher. Pass `null` to restore the default. */
export function setFetcher(f: Fetcher | null): void {
  fetcher = f ?? defaultFetcher;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveSystemDeno(): string {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["deno"], {
    encoding: "utf-8",
  });
  const path = r.stdout.split("\n")[0]?.trim();
  if (r.status !== 0 || !path) {
    throw new Error(
      "DITHER_USE_SYSTEM_DENO=1 was set but no `deno` found on PATH. Install Deno or unset the variable.",
    );
  }
  return path;
}

async function extractDeno(zipBytes: Uint8Array, scratch: string): Promise<string> {
  const zipPath = join(scratch, "deno.zip");
  await writeFile(zipPath, zipBytes);
  const r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", scratch], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`unzip failed (status ${r.status}): ${r.stderr || r.stdout}`);
  }
  // Find the `deno` binary in the extracted tree (top-level on every release today).
  const entries = await readdir(scratch);
  const denoName = entries.find((e) => e === "deno" || e === "deno.exe");
  if (!denoName) throw new Error("deno binary not found in archive");
  return join(scratch, denoName);
}

async function performInstall(target: Target, finalPath: string): Promise<void> {
  const url = downloadUrl(target);
  process.stderr.write(`dither: downloading deno v${VERSION} (${target}, ~40 MB)…\n`);
  const bytes = await fetcher(url);
  const got = sha256(bytes);
  const want = overrideHashes[target] ?? HASHES[target];
  if (got !== want) {
    throw new Error(
      `dither: sha256 mismatch for deno v${VERSION} ${target}\n` +
        `  expected: ${want}\n  got:      ${got}\n` +
        `  url:      ${url}\n` +
        `  retry: re-run the same command. If this persists, the upstream release may have been tampered with — file an issue.`,
    );
  }
  // Scratch dir lives next to the final path so `rename(2)` always operates
  // within one filesystem. Putting scratch under `os.tmpdir()` would EXDEV on
  // Linux when /tmp is tmpfs and $HOME is on a different volume.
  await mkdir(binDir(), { recursive: true });
  const scratch = await mkdtemp(join(binDir(), ".tmp-deno-"));
  try {
    const extractedPath = await extractDeno(bytes, scratch);
    await chmod(extractedPath, 0o755);
    await rename(extractedPath, finalPath);
    process.stderr.write(`dither: installed deno v${VERSION} at ${finalPath}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return existsSync(path);
}

/**
 * Idempotent: returns the absolute path to a verified Deno binary. If the
 * pinned binary is already installed, returns immediately. Otherwise downloads,
 * verifies, installs, and returns. Concurrent callers coordinate via a lock
 * keyed `bin:deno-<version>`; exactly one download happens.
 */
export async function ensureDeno(): Promise<string> {
  if (process.env.DITHER_USE_SYSTEM_DENO === "1") return resolveSystemDeno();

  const target = detectTarget();
  const finalPath = managedDenoPath();
  if (existsSync(finalPath)) return finalPath;

  const lockName = `bin:deno-${VERSION}`;
  const handle = await acquire(lockName);
  if (!handle) {
    // Another process is installing. Wait for the binary to land, then return.
    const ok = await waitForFile(finalPath, 10 * 60_000);
    if (!ok) {
      throw new Error(
        `dither: timed out waiting for concurrent deno install at ${finalPath}. ` +
          `Retry the command; if it persists, remove ${binDir()} and try again.`,
      );
    }
    return finalPath;
  }

  try {
    if (existsSync(finalPath)) return finalPath;
    await performInstall(target, finalPath);
    return finalPath;
  } finally {
    await release(handle);
  }
}
