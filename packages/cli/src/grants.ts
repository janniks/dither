import picomatch from "picomatch";
import { readdir, readFile } from "node:fs/promises";
import { validateCollectionPathSegment } from "./collection-registry";
import { grantsDirPath, grantsPath } from "./home";
import { writePrivateJson } from "./secure-json";
import type { Manifest } from "./manifest";

/**
 * The grants file at `~/.dither/grants/<name>.json` — the user's consented
 * permissions, written at install. This type IS the on-disk shape; there is
 * no translation layer. The daemon reads top-level `schedule`/`watch` (the
 * consented values), never `manifest.schedule`/`manifest.watch` (the
 * declared ones, kept for reporting).
 */
export interface Grants {
  name: string;
  version?: string;
  installedAt?: string;
  manifest?: Manifest;
  /** `null` = explicitly disabled; absent = legacy file (also disabled). */
  schedule?: string | null;
  watch?: { collections: string[]; dirs?: string[]; glob?: string } | null;
  env?: Record<string, string>;
  envRefs?: string[];
  files?: Record<string, string>;
  net: string[];
  create: string[];
  edit: string[];
}

/**
 * The single reader. Returns the parsed object itself (unknown fields
 * survive a read-modify-write round trip), with `create`/`edit`/`net`
 * defaulted to `[]` and `name` defaulted from the filename. `null` on a
 * missing file; corrupt JSON throws — a run must not silently proceed
 * with empty permissions.
 */
export async function readGrants(name: string): Promise<Grants | null> {
  let raw: string;
  try {
    raw = await readFile(grantsPath(name), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Grants;
  parsed.name ??= name;
  parsed.net ??= [];
  parsed.create ??= [];
  parsed.edit ??= [];
  return parsed;
}

export async function writeGrants(name: string, g: Grants): Promise<void> {
  await writePrivateJson(grantsPath(name), g);
}

/** Every installed plugin's grants, sorted by name. */
export async function listGrants(): Promise<Grants[]> {
  let files: string[];
  try {
    files = await readdir(grantsDirPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
  const out = await Promise.all(names.map(readGrants));
  return out.filter((g): g is Grants => g !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Grant patterns and coverage queries.
 *
 * A **Grant** authorises a plugin to write into specific paths under the
 * library. A grant is a glob pattern over the collection-path namespace —
 * same per-segment rules as a concrete collection path, except `*` and
 * `**` are allowed segments.
 *
 * Two surfaces:
 *   - `validateGrantPattern(pattern)` — used at install / configure time
 *     to fail loudly on typo'd patterns rather than silent literal match.
 *   - `grantsCover(grants, collection)` — used at promote time to authorise
 *     a write to a concrete collection path.
 *
 * Examples of valid grant patterns:
 *   "notes"          a single collection
 *   "messages/**"    matches messages and any descendant
 *   "feeds/*"        matches direct children only
 */

/**
 * Validate a grant pattern. Throws on violation; returns void on success.
 */
export function validateGrantPattern(pattern: string): void {
  if (!pattern) throw new Error(`grant pattern is empty`);
  if (pattern.startsWith("/") || pattern.endsWith("/")) {
    throw new Error(`grant pattern '${pattern}' must not start or end with '/'`);
  }
  if (pattern.includes("//")) {
    throw new Error(`grant pattern '${pattern}' contains an empty segment ('//')`);
  }
  for (const seg of pattern.split("/")) {
    if (seg === "*" || seg === "**") continue;
    validateCollectionPathSegment(seg, pattern);
  }
  // Catch unclosed picomatch metacharacters that would silently fall back
  // to literal-match — typo'd patterns should fail at install, not promote.
  if (countUnmatched(pattern, "[", "]") !== 0) {
    throw new Error(`grant pattern '${pattern}' has unmatched '[' or ']'`);
  }
  if (countUnmatched(pattern, "(", ")") !== 0) {
    throw new Error(`grant pattern '${pattern}' has unmatched '(' or ')'`);
  }
  if (countUnmatched(pattern, "{", "}") !== 0) {
    throw new Error(`grant pattern '${pattern}' has unmatched '{' or '}'`);
  }
}

function countUnmatched(s: string, open: string, close: string): number {
  let depth = 0;
  for (const ch of s) {
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth < 0) return depth;
  }
  return depth;
}

const matcherCache = new Map<string, (s: string) => boolean>();
const MATCHER_CACHE_LIMIT = 256;

function compile(glob: string): (s: string) => boolean {
  const hit = matcherCache.get(glob);
  if (hit) return hit;
  const m = picomatch(glob, { dot: false });
  if (matcherCache.size >= MATCHER_CACHE_LIMIT) {
    // Cheap LRU: evict the oldest entry.
    const oldest = matcherCache.keys().next().value;
    if (oldest !== undefined) matcherCache.delete(oldest);
  }
  matcherCache.set(glob, m);
  return m;
}

/**
 * Returns true iff at least one grant pattern matches `collection`.
 *
 * Special-case: a pattern of the form `<X>/**` also covers the bare `<X>` —
 * this is the user-friendly default. Plugin authors granting a subtree
 * almost always want the parent included.
 */
export function grantsCover(grants: readonly string[], collection: string): boolean {
  for (const g of grants) {
    if (compile(g)(collection)) return true;
    if (g.endsWith("/**")) {
      const parent = g.slice(0, -"/**".length);
      if (parent === collection) return true;
    }
  }
  return false;
}
