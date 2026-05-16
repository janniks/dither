import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * Locate the user's qmd config (global only for Phase 1) and pull collection
 * refs out of it. Returns `source: null` and an empty collection list if no
 * config exists — init's discovery step is a silent no-op in that case.
 */
export async function discoverQmdCollections(_libraryPath: string): Promise<QmdDiscoveryResult> {
  const warnings: string[] = [];
  const globalPath = firstExisting(globalQmdConfigCandidates());
  if (!globalPath) return { source: null, collections: [], warnings };

  const doc = await readQmdYaml(globalPath, warnings);
  const collections = doc === null ? [] : extractCollections(doc, warnings, globalPath);
  return {
    source: { path: globalPath, kind: "global" },
    collections,
    warnings,
  };
}

export interface AdoptionDiff {
  adopted: Array<{ name: string; path: string }>;
  skippedInLibrary: string[];
  skippedInvalid: Array<{ name: string; reason: string }>;
}

/**
 * Apply discovered qmd collections to a dither config. Pure-ish — only
 * I/O is the `realpathSync` inside `addExternal` for canonicalisation.
 * Reuses `addExternal`'s validation so overlap/collision rules stay
 * defined in one place.
 *
 * Skip rules (Phase 1):
 *   - `/` in name → sanitised to `-`
 *   - canonical path inside library.path → reported as "in library", skipped
 *   - any other RegistryError → reported in skippedInvalid with the message
 *     (Phase 2 will rename on NAME_COLLISION instead of skipping)
 */
export function applyQmdImport(
  cfg: DitherConfig,
  result: QmdDiscoveryResult,
): { cfg: DitherConfig; diff: AdoptionDiff } {
  const diff: AdoptionDiff = { adopted: [], skippedInLibrary: [], skippedInvalid: [] };
  let next = cfg;
  for (const c of result.collections) {
    const name = sanitiseName(c.name);
    try {
      const res = addExternal(next, c.path, name);
      next = res.cfg;
      diff.adopted.push({ name: res.entry.name, path: res.entry.path });
    } catch (err) {
      if (err instanceof RegistryError && err.code === "OVERLAPS_LIBRARY") {
        diff.skippedInLibrary.push(c.name);
        continue;
      }
      diff.skippedInvalid.push({
        name: c.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { cfg: next, diff };
}

function sanitiseName(name: string): string {
  return name.replace(/\//g, "-");
}
