import { mkdir, cp, readFile, writeFile, rm, lstat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveHome } from "./home";
import { parsePackage, type Manifest, type ParsedPackage } from "./manifest";
import { validateGrantPattern } from "./collection-paths";

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
}

export interface InstalledPlugin {
  name: string;
  version: string;
  dest: string;
}

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
    throw new Error(
      `Required env '${def.name}' was not provided (no value, no --allow-env grant, no default).`,
    );
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

  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }
  await mkdir(destDir, { recursive: true });
  await cp(sourcePath, destDir, { recursive: true });

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

  return { name: parsed.name, version: parsed.version, dest: destDir };
}
