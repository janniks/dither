import picomatch from "picomatch";
import { validateCollectionPathSegment } from "./collection-registry";

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
