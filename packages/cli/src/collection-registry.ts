import { accessSync, constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { DitherConfig, ExternalCollection } from "./config";
import { validateCollectionPath } from "./collection-paths";

/**
 * What dither knows about one collection — either auto-discovered from the
 * library tree or registered as an external mount. The same shape carries
 * the runtime status so callers (promote, index, list) can branch on
 * missing mounts without re-statting themselves.
 */
export interface Collection {
  name: string;
  path: string;
  source: "library" | "external";
  status: "ok" | "missing";
}

/**
 * Thrown by `addExternal` / `removeExternal` for every validation rule in
 * the spec. The `code` field is stable and `commands/collection.ts`
 * branches on it for user-facing copy. The base message is fine to print
 * directly if no special handling is needed.
 */
export class RegistryError extends Error {
  constructor(public readonly code: RegistryErrorCode, message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export type RegistryErrorCode =
  | "PATH_NOT_FOUND"
  | "PATH_NOT_DIR"
  | "PATH_NOT_WRITABLE"
  | "OVERLAPS_LIBRARY"
  | "OVERLAPS_EXTERNAL"
  | "NAME_INVALID"
  | "NAME_HAS_SLASH"
  | "NAME_EMPTY"
  | "NAME_COLLISION"
  | "NOT_REGISTERED"
  | "REMOVE_LIBRARY";

/**
 * Slugify a directory name into a collection name. Lowercases, replaces any
 * char outside `[a-z0-9._-]` with `-`, collapses runs of `-`, trims leading
 * and trailing `-`. Returns "" if nothing survives — callers must treat
 * empty as a validation failure.
 */
export function defaultSlug(path: string): string {
  // basename, tolerant of trailing separators.
  const trimmed = path.replace(/[\\/]+$/, "");
  const base = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Expand `~/` to the user's home and resolve to an absolute path. Mirrors
 * the helper in `commands/init.ts` rather than importing it, to keep this
 * module dependency-free aside from `config` and `collection-paths`.
 */
function expandUserPath(input: string): string {
  const expanded = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return resolve(expanded);
}

/**
 * Returns true iff `a` is the same path as `b`, lives inside `b`, or `b`
 * lives inside `a`. All three count as "overlap" for the purposes of the
 * spec's no-overlap rule.
 */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aSep = a.endsWith(sep) ? a : a + sep;
  const bSep = b.endsWith(sep) ? b : b + sep;
  return aSep.startsWith(bSep) || bSep.startsWith(aSep);
}

/**
 * Auto-discover the library's top-level subdirectories. The library root
 * may not exist yet (empty installs); a missing root yields an empty list.
 */
function librarySubdirNames(libraryPath: string): string[] {
  try {
    return readdirSync(libraryPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Resolve the input path to its canonical absolute form. If the path
 * doesn't exist, that's a typed error (callers pre-validate this); if it
 * does, follow symlinks so a later symlink swap can't widen the registered
 * scope — same posture as `dither init --library`.
 */
function canonicalisePath(input: string): string {
  const absolute = expandUserPath(input);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new RegistryError("PATH_NOT_DIR", `path is not a directory: ${absolute}`);
    }
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    throw new RegistryError("PATH_NOT_FOUND", `path does not exist: ${absolute}`);
  }
  const real = realpathSync(absolute);
  try {
    const realStat = lstatSync(real);
    if (!realStat.isDirectory()) {
      throw new RegistryError("PATH_NOT_DIR", `path is not a directory: ${real}`);
    }
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    throw new RegistryError("PATH_NOT_FOUND", `path does not exist: ${real}`);
  }
  try {
    accessSync(real, constants.W_OK);
  } catch {
    throw new RegistryError("PATH_NOT_WRITABLE", `path is not writable: ${real}`);
  }
  return real;
}

/**
 * Run the spec's add-time validation on a resolved name. Library subdir
 * names and existing externals are both checked case-insensitively for
 * collisions.
 */
function validateName(
  name: string,
  cfg: DitherConfig,
  librarySubdirs: readonly string[],
): void {
  if (!name) {
    throw new RegistryError(
      "NAME_EMPTY",
      `default name (derived from folder leaf) is empty after sanitising; pass --name explicitly`,
    );
  }
  if (name.includes("/")) {
    throw new RegistryError(
      "NAME_HAS_SLASH",
      `external collection name '${name}' must not contain '/'`,
    );
  }
  try {
    validateCollectionPath(name);
  } catch (err) {
    throw new RegistryError(
      "NAME_INVALID",
      err instanceof Error ? err.message : String(err),
    );
  }
  const lower = name.toLowerCase();
  for (const subdir of librarySubdirs) {
    if (subdir.toLowerCase() === lower) {
      throw new RegistryError(
        "NAME_COLLISION",
        `name '${name}' collides with library subdir '${subdir}'`,
      );
    }
  }
  for (const ext of cfg.collections.external) {
    if (ext.name.toLowerCase() === lower) {
      throw new RegistryError(
        "NAME_COLLISION",
        `name '${name}' collides with external collection '${ext.name}'`,
      );
    }
  }
}

/**
 * Register a new external collection. Returns an updated config; the
 * caller is responsible for persisting and triggering any qmd-side work.
 * The library path on `cfg` is treated as already canonical (it is, post
 * `dither init`).
 */
export function addExternal(
  cfg: DitherConfig,
  inputPath: string,
  name?: string,
): { cfg: DitherConfig; entry: ExternalCollection } {
  const real = canonicalisePath(inputPath);

  if (pathsOverlap(real, cfg.library.path)) {
    throw new RegistryError(
      "OVERLAPS_LIBRARY",
      `path '${real}' overlaps the library at '${cfg.library.path}'`,
    );
  }
  for (const ext of cfg.collections.external) {
    if (pathsOverlap(real, ext.path)) {
      throw new RegistryError(
        "OVERLAPS_EXTERNAL",
        `path '${real}' overlaps existing external '${ext.name}' at '${ext.path}'`,
      );
    }
  }

  const resolvedName = name ?? defaultSlug(real);
  validateName(resolvedName, cfg, librarySubdirNames(cfg.library.path));

  const entry: ExternalCollection = { name: resolvedName, path: real };
  return {
    cfg: {
      ...cfg,
      collections: { external: [...cfg.collections.external, entry] },
    },
    entry,
  };
}

/**
 * Drop an external collection by name. Throws if the name is unknown, or
 * if it names a library subdir (those aren't removable through the
 * registry — they're filesystem-truth).
 */
export function removeExternal(cfg: DitherConfig, name: string): DitherConfig {
  const lower = name.toLowerCase();
  if (librarySubdirNames(cfg.library.path).some((s) => s.toLowerCase() === lower)) {
    throw new RegistryError(
      "REMOVE_LIBRARY",
      `'${name}' is a library subdir, not an external collection. Remove the directory under '${cfg.library.path}' if you want to drop it.`,
    );
  }
  const next = cfg.collections.external.filter((e) => e.name !== name);
  if (next.length === cfg.collections.external.length) {
    throw new RegistryError(
      "NOT_REGISTERED",
      `no external collection named '${name}' is registered`,
    );
  }
  return { ...cfg, collections: { external: next } };
}

/**
 * Union of library subdirs and registered externals. Each entry carries
 * its runtime status so callers can warn-and-skip missing externals.
 */
export function loadRegistry(cfg: DitherConfig): Collection[] {
  const out: Collection[] = [];
  for (const name of librarySubdirNames(cfg.library.path)) {
    out.push({
      name,
      path: join(cfg.library.path, name),
      source: "library",
      status: "ok",
    });
  }
  for (const ext of cfg.collections.external) {
    out.push({
      name: ext.name,
      path: ext.path,
      source: "external",
      status: externalStatus(ext.path),
    });
  }
  return out;
}

/**
 * Look up a single collection by name. Returns `undefined` for unknown
 * names (the caller should treat that as "auto-create under library").
 */
export function resolveCollection(
  cfg: DitherConfig,
  name: string,
): Collection | undefined {
  for (const ext of cfg.collections.external) {
    if (ext.name === name) {
      return {
        name: ext.name,
        path: ext.path,
        source: "external",
        status: externalStatus(ext.path),
      };
    }
  }
  const subdir = librarySubdirNames(cfg.library.path).find((s) => s === name);
  if (subdir) {
    return {
      name: subdir,
      path: join(cfg.library.path, subdir),
      source: "library",
      status: "ok",
    };
  }
  return undefined;
}

function externalStatus(path: string): "ok" | "missing" {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() || stat.isSymbolicLink() ? "ok" : "missing";
  } catch {
    return "missing";
  }
}
