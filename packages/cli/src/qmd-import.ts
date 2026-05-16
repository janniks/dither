import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { DitherConfig } from "./config";
import { addExternal, RegistryError } from "./collection-registry";

/**
 * Discover an existing qmd setup so `dither init` can adopt its collections
 * as external mounts. We read only the collection names + paths — see
 * `specs/init-adopt-qmd.md` "What we read" for the explicit ignore list.
 */

export interface QmdCollectionRef {
  name: string;
  path: string;
}

export interface QmdDiscoverySource {
  path: string;
  kind: "global" | "local";
}

export interface QmdDiscoveryResult {
  source: QmdDiscoverySource | null;
  collections: QmdCollectionRef[];
  warnings: string[];
}

/**
 * Resolve qmd's global config file path, mirroring qmd's own precedence
 * (`src/collections.ts:getConfigDir` in tobi/qmd). Returns the .yml form
 * first, then falls back to .yaml — qmd writes .yml by default but the
 * codebase reads both.
 */
function globalQmdConfigCandidates(): string[] {
  const dir =
    process.env.QMD_CONFIG_DIR ??
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "qmd")
      : join(homedir(), ".config", "qmd"));
  return [join(dir, "index.yml"), join(dir, "index.yaml")];
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

interface ParsedYaml {
  collections?: Record<string, unknown>;
}

/**
 * Pull collection name + path out of a parsed qmd YAML document. We ignore
 * every other key (pattern, ignore, context, update, models, …) — adoption
 * is "name + path only" by design.
 */
function extractCollections(doc: unknown, warnings: string[], source: string): QmdCollectionRef[] {
  if (!doc || typeof doc !== "object") return [];
  const colls = (doc as ParsedYaml).collections;
  if (!colls || typeof colls !== "object") return [];
  const out: QmdCollectionRef[] = [];
  for (const [name, raw] of Object.entries(colls)) {
    if (!raw || typeof raw !== "object") {
      warnings.push(`${source}: collection '${name}' is not an object — skipped`);
      continue;
    }
    const path = (raw as { path?: unknown }).path;
    if (typeof path !== "string" || !path) {
      warnings.push(`${source}: collection '${name}' has no path — skipped`);
      continue;
    }
    out.push({ name, path });
  }
  return out;
}

async function readQmdYaml(path: string, warnings: string[]): Promise<unknown | null> {
  const raw = await readFile(path, "utf-8").catch((err) => {
    warnings.push(`could not read qmd config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (raw === null) return null;
  try {
    return parseYaml(raw);
  } catch (err) {
    warnings.push(`qmd config at ${path} is malformed YAML: ${err instanceof Error ? err.message : String(err)} — ignored`);
    return null;
  }
}

/**
 * Walk upward from `start` looking for a `.qmd/index.yaml` or `.qmd/index.yml`.
 * Mirrors qmd's `findLocalConfigPath` (src/collections.ts) so a project-local
 * qmd setup pointed at the same library dir is picked up too.
 */
function findLocalQmdConfig(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    for (const name of ["index.yaml", "index.yml"]) {
      const candidate = join(dir, ".qmd", name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate the user's qmd config and pull collection refs out of it. Sources
 * are merged: a local `.qmd/index.yaml` walked up from `libraryPath` wins
 * on name conflicts (closer-to-library is more specific). Returns
 * `source: null` only when neither source exists — init's discovery step
 * is a silent no-op in that case.
 */
export async function discoverQmdCollections(libraryPath: string): Promise<QmdDiscoveryResult> {
  const warnings: string[] = [];
  const globalPath = firstExisting(globalQmdConfigCandidates());
  const localPath = findLocalQmdConfig(libraryPath);

  if (!globalPath && !localPath) return { source: null, collections: [], warnings };

  // Read both, merging by name with local-wins precedence. Order in the
  // returned list: global first, then local (so a same-name local entry
  // replaces the global one in the map but keeps a stable iteration order
  // suitable for the summary).
  const byName = new Map<string, QmdCollectionRef>();
  if (globalPath) {
    const doc = await readQmdYaml(globalPath, warnings);
    if (doc !== null) {
      for (const c of extractCollections(doc, warnings, globalPath)) {
        byName.set(c.name, c);
      }
    }
  }
  if (localPath) {
    const doc = await readQmdYaml(localPath, warnings);
    if (doc !== null) {
      for (const c of extractCollections(doc, warnings, localPath)) {
        byName.set(c.name, c);
      }
    }
  }

  // Prefer the more specific source for the headline path — local trumps
  // global when both are present.
  const source: QmdDiscoverySource = localPath
    ? { path: localPath, kind: "local" }
    : { path: globalPath!, kind: "global" };

  return { source, collections: [...byName.values()], warnings };
}

export interface AdoptedEntry {
  name: string;
  path: string;
  /** Original name from the qmd YAML, set only when sanitised or suffixed. */
  renamedFrom?: string;
}

export interface AdoptionDiff {
  adopted: AdoptedEntry[];
  skippedInLibrary: string[];
  skippedInvalid: Array<{ name: string; reason: string }>;
}

/**
 * Apply discovered qmd collections to a dither config. Pure-ish — only
 * I/O is the `realpathSync` inside `addExternal` for canonicalisation.
 * Reuses `addExternal`'s validation so overlap/collision rules stay
 * defined in one place.
 *
 * Skip / rename rules:
 *   - `/` in name → sanitised to `-`
 *   - canonical path inside library.path → reported as "in library", skipped
 *   - NAME_COLLISION (with a library subdir or a prior adopted external) →
 *     retry with `-1`, `-2`, … up to 50 attempts, then give up as invalid
 *   - any other RegistryError → reported in skippedInvalid with the message
 */
export function applyQmdImport(
  cfg: DitherConfig,
  result: QmdDiscoveryResult,
): { cfg: DitherConfig; diff: AdoptionDiff } {
  const diff: AdoptionDiff = { adopted: [], skippedInLibrary: [], skippedInvalid: [] };
  let next = cfg;
  for (const c of result.collections) {
    const base = sanitiseName(c.name);
    const outcome = tryAdoptWithRename(next, c, base);
    if (outcome.kind === "ok") {
      next = outcome.cfg;
      const renamedFrom = outcome.entry.name !== c.name ? c.name : undefined;
      diff.adopted.push({ name: outcome.entry.name, path: outcome.entry.path, renamedFrom });
      continue;
    }
    if (outcome.kind === "in-library") {
      diff.skippedInLibrary.push(c.name);
      continue;
    }
    diff.skippedInvalid.push({ name: c.name, reason: outcome.reason });
  }
  return { cfg: next, diff };
}

type AdoptOutcome =
  | { kind: "ok"; cfg: DitherConfig; entry: { name: string; path: string } }
  | { kind: "in-library" }
  | { kind: "invalid"; reason: string };

const MAX_RENAME_ATTEMPTS = 50;

function tryAdoptWithRename(
  cfg: DitherConfig,
  c: QmdCollectionRef,
  base: string,
): AdoptOutcome {
  let lastErr: RegistryError | undefined;
  for (let i = 0; i < MAX_RENAME_ATTEMPTS; i++) {
    const name = i === 0 ? base : `${base}-${i}`;
    try {
      const res = addExternal(cfg, c.path, name);
      return { kind: "ok", cfg: res.cfg, entry: res.entry };
    } catch (err) {
      if (!(err instanceof RegistryError)) {
        return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
      }
      if (err.code === "OVERLAPS_LIBRARY") return { kind: "in-library" };
      if (err.code !== "NAME_COLLISION") {
        return { kind: "invalid", reason: err.message };
      }
      lastErr = err;
      // try next suffix
    }
  }
  return { kind: "invalid", reason: lastErr?.message ?? "name collision exhausted retries" };
}

function sanitiseName(name: string): string {
  return name.replace(/\//g, "-");
}
