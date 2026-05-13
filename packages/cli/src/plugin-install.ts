import { mkdir, cp, readFile, writeFile, rm, lstat, realpath, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveHome } from "./home";
import { parsePackage, type Manifest, type ParsedPackage } from "./manifest";
import { validateGrantPattern } from "./collection-paths";
import { maybeWarnInstall } from "./tcc-hint";
import { ensureDeno } from "./deno-bootstrap";

/**
 * Write a fresh deno.json at the install destination. The plugin author's
 * deno.json (if any) was filtered out during cp — we *generate* one with:
 *   - `nodeModulesDir: "auto"` so the install-time `deno cache` populates
 *     a self-contained `<destDir>/node_modules`.
 *   - `imports."@dither/plugin"` pinned to the host's SDK path so plugins
 *     get the SDK shipped with this dither install rather than whatever
 *     they had pinned during development. Once @dither/plugin lands on
 *     npm, plugins listing it as an npm dep still work — the import map
 *     entry wins, keeping host/plugin SDKs in sync.
 */
async function writeDenoConfig(destDir: string, sdkUrl: string): Promise<void> {
  const cfg = {
    nodeModulesDir: "auto" as const,
    imports: { "@dither/plugin": sdkUrl },
  };
  await writeFile(join(destDir, "deno.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}

/**
 * Run `deno cache plugin.ts` in the install dir so npm + JSR dependencies
 * are fetched into a self-contained `<destDir>/node_modules`. The first
 * plugin run is then a local-only operation — no network, no
 * source-directory dependency.
 */
async function prefetchDeps(destDir: string): Promise<void> {
  if (!existsSync(join(destDir, "plugin.ts"))) return;
  const denoPath = await ensureDeno();
  await new Promise<void>((res, rej) => {
    const child = spawn(denoPath, ["cache", "plugin.ts"], {
      cwd: destDir,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", rej);
    child.on("exit", (code) => {
      if (code === 0) return res();
      rej(new Error(`'deno cache' exited with code ${code} during install`));
    });
  });
}

// Files we never carry over from the source plugin — we generate our own.
function shouldSkipDuringCopy(src: string): boolean {
  if (/(^|\/)node_modules(\/|$)/.test(src)) return true;
  const base = src.split("/").pop() ?? "";
  return base === "deno.json" || base === "deno.jsonc" || base === "deno.lock";
}

export interface InstallOptions {
  source: string;
  /** Per-plugin literal env values, keyed by name. */
  env?: Record<string, string>;
  /** Names of global env values this plugin may read. */
  envRefs?: string[];
  /** Paths for the manifest's declared `files[]`, keyed by `id`. */
  files?: Record<string, string>;
  /** Net hosts the plugin may reach (subset of manifest `net`). Empty / undefined → grant manifest's full declaration. */
  net?: string[];
  /** Collections the plugin may write to (subset of manifest `collections`). Empty / undefined → grant manifest's full declaration. */
  collections?: string[];
  /** Dev mode: symlink the install destination to the source path so author
   *  edits take effect without reinstall. Uses the source's existing
   *  node_modules + deno.json as-is. */
  symlink?: boolean;
}

export interface InstalledPlugin {
  name: string;
  version: string;
  dest: string;
}

export const MISSING_ENV = "MISSING_ENV";

function resolveEnv(
  declared: Manifest["env"],
  provided: Record<string, string> | undefined,
  envRefs: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  const refSet = new Set(envRefs);
  for (const def of declared ?? []) {
    const userValue = provided?.[def.name];
    if (userValue !== undefined) {
      result[def.name] = userValue;
      continue;
    }
    if (refSet.has(def.name)) {
      // Grant resolves at run time from global env; literal not stored here.
      continue;
    }
    if (def.default !== undefined) {
      result[def.name] = def.default;
      continue;
    }
    const err = new Error(
      `required env '${def.name}' was not provided. Pass it with --env ${def.name}=… or grant it with --allow-env ${def.name}.`,
    ) as Error & { code: string };
    err.code = MISSING_ENV;
    throw err;
  }
  return result;
}

async function resolveFiles(
  declared: Manifest["files"],
  provided: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const def of declared ?? []) {
    const userValue = provided?.[def.id];
    if (userValue === undefined) {
      if (def.required) {
        throw new Error(`Required file '${def.id}' was not provided.`);
      }
      continue;
    }
    const inputPath = resolve(userValue);
    if (!existsSync(inputPath)) {
      throw new Error(`File '${def.id}' path does not exist: ${inputPath}`);
    }
    // Canonicalise at install. Deno's --allow-read follows symlinks at
    // runtime, so if we stored the user's potentially-symlinked path,
    // replacing the link later would silently widen access to wherever
    // the new target points. Storing the realpath pins the grant to its
    // install-time destination.
    const absPath = await realpath(inputPath);
    const stats = await lstat(absPath);
    if (def.kind === "file" && !stats.isFile()) {
      throw new Error(`File '${def.id}' must be a file, got: ${absPath}`);
    }
    if (def.kind === "folder" && !stats.isDirectory()) {
      throw new Error(`File '${def.id}' must be a folder, got: ${absPath}`);
    }
    result[def.id] = absPath;
  }
  return result;
}

/**
 * Resolve a grant list at install time. The manifest declaration is a
 * *default seed* — used when the user doesn't pass an explicit flag.
 * When the user does pass one, it wins, full stop. Manifest is no longer
 * a ceiling; the grants file is the source of truth at promote.
 */
function resolveAllowList(
  declared: string[] | undefined,
  provided: string[] | undefined,
): string[] {
  if (!provided || provided.length === 0) {
    return Array.from(new Set(declared ?? []));
  }
  return Array.from(new Set(provided));
}

export async function installPlugin(opts: InstallOptions): Promise<InstalledPlugin> {
  // Trigger the managed-deno bootstrap on first install so the user pays the
  // download cost here rather than mid-run. Idempotent; cheap on later calls.
  await ensureDeno();

  const sourcePath = resolve(opts.source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Plugin source not found: ${sourcePath}`);
  }
  const pkgPath = join(sourcePath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json at ${sourcePath}`);
  }

  const pkgRaw = JSON.parse(await readFile(pkgPath, "utf-8")) as unknown;
  const parsed: ParsedPackage = parsePackage(pkgRaw);

  // Validate everything before touching disk so a missing-required failure
  // rolls back cleanly with no half-installed state.
  const envRefs = opts.envRefs ?? [];
  const env = resolveEnv(parsed.manifest.env, opts.env, envRefs);
  const files = await resolveFiles(parsed.manifest.files, opts.files);
  const net = resolveAllowList(parsed.manifest.net, opts.net);
  const collections = resolveAllowList(parsed.manifest.collections, opts.collections);
  for (const pattern of collections) validateGrantPattern(pattern);

  const home = resolveHome();
  const destDir = join(home, "plugins", parsed.name);

  // Reinstall is intentionally non-atomic for v0 simplicity: rm → mkdir → cp.
  // If the cp fails midway (disk full, permission, killed), the previous
  // install is gone and the new one is half-copied. Acceptable until we have
  // real users — the user can re-run install. A tmpdir-then-rename pattern is
  // the future fix; tracked in the review report.
  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }
  await mkdir(destDir, { recursive: true });
  if (opts.symlink) {
    // Dev mode: symlink dest → source so author edits flow through without
    // reinstall. node_modules + deno.json from the source location are
    // used as-is; the author owns whatever's in there.
    await symlink(sourcePath, destDir);
  } else {
    // Skip node_modules + any deno.* files during copy. Deno's `.deno/`
    // symlink trees often use absolute paths back to the source dir, and
    // the author's deno.json may pin `@dither/plugin` to a dev path that
    // doesn't exist on the installer's machine. We regenerate both from
    // scratch below.
    await cp(sourcePath, destDir, {
      recursive: true,
      filter: (src) => !shouldSkipDuringCopy(src),
    });

    const sdkUrl = import.meta.resolve("@dither/plugin");
    await writeDenoConfig(destDir, sdkUrl);

    // Pre-fetch dependencies so the first plugin run isn't a network
    // round trip and the install fails loudly if a dep is unreachable.
    // Runs deno *outside* the sandbox — it needs network + write to
    // destDir.
    await prefetchDeps(destDir);
  }

  const grantsDir = join(home, "grants");
  await mkdir(grantsDir, { recursive: true });
  const grantsPath = join(grantsDir, `${parsed.name}.json`);
  await writeFile(
    grantsPath,
    JSON.stringify(
      {
        name: parsed.name,
        version: parsed.version,
        installedAt: new Date().toISOString(),
        manifest: parsed.manifest,
        env,
        envRefs,
        files,
        net,
        collections,
      },
      null,
      2,
    ),
  );

  // macOS-only proactive hint: warn if any granted file path lives under a
  // TCC-protected prefix (Messages, Mail, Photos, etc.). No-op elsewhere.
  maybeWarnInstall(files);

  return { name: parsed.name, version: parsed.version, dest: destDir };
}
