import { mkdir, cp, writeFile, rm, symlink, rename, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveHome } from "./home";
import { validateGrantPattern } from "./grants";
import { detectProtectedInstall, type ProtectedInstall } from "./tcc-hint";
import { ensureDeno } from "./deno-bootstrap";
import { writePrivateJson } from "./secure-json";
import {
  MissingInputsError,
  planInstall,
  readPackage,
  type InstallInputs,
} from "./plugin-install-interactive";

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

export type InstallOptions = InstallInputs & {
  source: string;
  /** Dev mode: symlink the install destination to the source path so author
   *  edits take effect without reinstall. Uses the source's existing
   *  node_modules + deno.json as-is. */
  symlink?: boolean;
};

export interface InstalledPlugin {
  name: string;
  version: string;
  dest: string;
  /** Set when at least one granted file path falls inside a macOS
   *  TCC-protected subtree; null otherwise. The command layer uses
   *  this to render the FDA note + open-Settings prompt. */
  protectedInstall: ProtectedInstall | null;
}

export { MissingInputsError } from "./plugin-install-interactive";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function replacePlugin(
  destDir: string,
  stageDir: string,
  grantsPath: string,
  grants: unknown,
): Promise<void> {
  const backupDir = join(
    dirname(destDir),
    `.${basename(destDir)}.${process.pid}.${randomUUID()}.old`,
  );
  const hadOld = await pathExists(destDir);
  let staged = false;

  try {
    if (hadOld) await rename(destDir, backupDir);
    await rename(stageDir, destDir);
    staged = true;
    try {
      await writePrivateJson(grantsPath, grants);
    } catch (err) {
      await rm(destDir, { recursive: true, force: true }).catch(() => undefined);
      if (hadOld) await rename(backupDir, destDir).catch(() => undefined);
      throw err;
    }
    if (hadOld) await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  } catch (err) {
    if (!staged && hadOld && !(await pathExists(destDir))) {
      await rename(backupDir, destDir).catch(() => undefined);
    }
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export async function installPlugin(opts: InstallOptions): Promise<InstalledPlugin> {
  // Trigger the managed-deno bootstrap on first install so the user pays the
  // download cost here rather than mid-run. Idempotent; cheap on later calls.
  await ensureDeno();

  const sourcePath = resolve(opts.source);
  const parsed = await readPackage(sourcePath);

  // Validate everything before touching disk so a missing-required failure
  // rolls back cleanly with no half-installed state.
  const plan = await planInstall(parsed, opts);
  if (!plan.ok) throw new MissingInputsError(plan.missing);
  const { env, envRefs, files, net, collections, schedule, watch } = plan.resolved;
  for (const pattern of collections) validateGrantPattern(pattern);

  const home = resolveHome();
  const destDir = join(home, "plugins", parsed.name);
  const parentDir = dirname(destDir);
  const stageDir = join(parentDir, `.${parsed.name}.${process.pid}.${randomUUID()}.tmp`);
  const grantsDir = join(home, "grants");
  const grantsPath = join(grantsDir, `${parsed.name}.json`);
  const grants = {
    name: parsed.name,
    version: parsed.version,
    installedAt: new Date().toISOString(),
    manifest: parsed.manifest,
    // Top-level `schedule` / `watch` are the user's consented choices —
    // the daemon reads these (never `manifest.schedule` / `manifest.watch`).
    // `null` = explicitly disabled. The manifest block stays untouched for
    // debug / `dither plugin list` reporting of the declared value.
    schedule,
    watch,
    env,
    envRefs,
    files,
    net,
    collections,
  };

  try {
    await mkdir(parentDir, { recursive: true });
    if (opts.symlink) {
      // Dev mode: symlink destDir → sourcePath so author edits flow through
      // without reinstall. node_modules + deno.json from the source location
      // are used as-is; the author owns whatever's in there.
      await symlink(sourcePath, stageDir);
    } else {
      await mkdir(stageDir, { recursive: true });
      // Skip node_modules + any deno.* files during copy. Deno's `.deno/`
      // symlink trees often use absolute paths back to the source dir, and
      // the author's deno.json may pin `@dither/plugin` to a dev path that
      // doesn't exist on the installer's machine. We regenerate both from
      // scratch below.
      await cp(sourcePath, stageDir, {
        recursive: true,
        filter: (src) => !shouldSkipDuringCopy(src),
      });

      const sdkUrl = import.meta.resolve("@dither/plugin");
      await writeDenoConfig(stageDir, sdkUrl);

      // Pre-fetch dependencies so the first plugin run isn't a network
      // round trip and the install fails loudly if a dep is unreachable.
      // Runs deno *outside* the sandbox — it needs network + write access.
      await prefetchDeps(stageDir);
    }

    await replacePlugin(destDir, stageDir, grantsPath, grants);
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    name: parsed.name,
    version: parsed.version,
    dest: destDir,
    protectedInstall: detectProtectedInstall(files),
  };
}
