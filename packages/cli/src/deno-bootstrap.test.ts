import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// Build a zip containing one file `deno` at the top level whose contents are
// a tiny shell script. Mirrors the upstream release layout closely enough to
// exercise the full extract → chmod → rename pipeline.
function buildFakeDenoZip(): Uint8Array {
  const scratch = mkdtempSync(join(tmpdir(), "fake-deno-zip-"));
  const denoPath = join(scratch, "deno");
  writeFileSync(denoPath, "#!/bin/sh\necho fake-deno $@\n", { mode: 0o755 });
  const zipPath = join(scratch, "out.zip");
  const r = spawnSync("zip", ["-j", zipPath, denoPath], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
  const bytes = new Uint8Array(readFileSync(zipPath));
  rmSync(scratch, { recursive: true, force: true });
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("deno-bootstrap", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevOptOut: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-deno-test-"));
    prevHome = process.env.DITHER_DIR;
    prevOptOut = process.env.DITHER_USE_SYSTEM_DENO;
    process.env.DITHER_DIR = home;
    delete process.env.DITHER_USE_SYSTEM_DENO;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    if (prevOptOut === undefined) delete process.env.DITHER_USE_SYSTEM_DENO;
    else process.env.DITHER_USE_SYSTEM_DENO = prevOptOut;
    rmSync(home, { recursive: true, force: true });
    const { setFetcher, setHashOverride, detectTarget } = await import("./deno-bootstrap");
    setFetcher(null);
    setHashOverride(detectTarget(), null);
  });

  it("happy path: download → verify → extract → chmod 0o755 → rename to final path", async () => {
    const { ensureDeno, managedDenoPath, setFetcher, setHashOverride, detectTarget } =
      await import("./deno-bootstrap");
    const zip = buildFakeDenoZip();
    setHashOverride(detectTarget(), sha256(zip));
    setFetcher(async () => zip);

    const path = await ensureDeno();
    expect(path).toBe(managedDenoPath());
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    // Binary is the actual extracted shell script, not the zip envelope.
    expect(readFileSync(path, "utf-8")).toContain("fake-deno");
  });

  it("hash mismatch: throws, leaves no binary at the final path", async () => {
    const { ensureDeno, managedDenoPath, setFetcher } = await import("./deno-bootstrap");
    setFetcher(async () => new Uint8Array([1, 2, 3, 4]));
    await expect(ensureDeno()).rejects.toThrow(/sha256 mismatch/);
    expect(existsSync(managedDenoPath())).toBe(false);
    // bin dir may exist (created mid-flow); confirm no deno-* files inside.
    const binPath = join(home, "bin");
    if (existsSync(binPath)) {
      const entries = readdirSync(binPath);
      expect(entries.filter((e) => e.startsWith("deno-"))).toEqual([]);
    }
  });

  it("opt-out: DITHER_USE_SYSTEM_DENO=1 returns a PATH-resolved deno, never fetches", async () => {
    const { ensureDeno, setFetcher, managedDenoPath } = await import("./deno-bootstrap");
    let called = false;
    setFetcher(async () => {
      called = true;
      return new Uint8Array();
    });
    process.env.DITHER_USE_SYSTEM_DENO = "1";
    const path = await ensureDeno();
    expect(called).toBe(false);
    expect(path).not.toBe(managedDenoPath());
    expect(existsSync(path)).toBe(true);
  });

  it("idempotency: second call short-circuits when the binary already exists", async () => {
    const { ensureDeno, managedDenoPath, setFetcher } = await import("./deno-bootstrap");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(managedDenoPath(), "preinstalled", { mode: 0o755 });
    let called = false;
    setFetcher(async () => {
      called = true;
      return new Uint8Array();
    });
    const path = await ensureDeno();
    expect(path).toBe(managedDenoPath());
    expect(called).toBe(false);
  });

  it("concurrency: parallel ensureDeno() calls trigger exactly one download", async () => {
    const { ensureDeno, managedDenoPath, setFetcher, setHashOverride, detectTarget } =
      await import("./deno-bootstrap");
    const zip = buildFakeDenoZip();
    setHashOverride(detectTarget(), sha256(zip));

    let calls = 0;
    setFetcher(async () => {
      calls += 1;
      // Slow enough for the second caller to enter the wait branch.
      await new Promise((r) => setTimeout(r, 200));
      return zip;
    });

    const [a, b] = await Promise.all([ensureDeno(), ensureDeno()]);
    expect(calls).toBe(1);
    expect(a).toBe(managedDenoPath());
    expect(b).toBe(managedDenoPath());
    expect(existsSync(managedDenoPath())).toBe(true);
  });
});
