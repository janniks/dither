import picomatch from "picomatch";

/**
 * A concrete collection path — the value a plugin emits in frontmatter.
 *
 *   - non-empty
 *   - segments are `[a-zA-Z0-9_-]+` plus a leading dot only inside the
 *     middle of a segment (e.g. `notes.md` permitted, `.git` not)
 *   - segments separated by single `/`, no leading/trailing `/`, no `//`
 *   - no `..` or `.` segment, no `...`/`....` (Windows normalisation traps)
 *   - no trailing `.md` (paths name directories, not files)
 *
 * Throws on violation; returns void on success.
 */
export function validateCollectionPath(path: string): void {
  if (!path) throw new Error(`collection path is empty`);
  if (path.startsWith("/") || path.endsWith("/")) {
    throw new Error(`collection path '${path}' must not start or end with '/'`);
  }
  if (path.includes("//")) {
    throw new Error(`collection path '${path}' contains an empty segment ('//')`);
  }
  if (path.toLowerCase().endsWith(".md")) {
    throw new Error(`collection path '${path}' must not end with '.md' (it names a directory)`);
  }
  for (const seg of path.split("/")) {
    validateSegment(seg, path);
  }
}

function validateSegment(seg: string, path: string): void {
  if (seg === "." || seg === "..") {
    throw new Error(`collection path '${path}' must not contain '${seg}'`);
  }
  // `...`, `....` etc. — Windows / SMB can normalise these to `..`.
  if (/^\.+$/.test(seg)) {
    throw new Error(`collection path '${path}' segment '${seg}' is dot-only`);
  }
  // Disallow leading `.` to keep dotfiles (`.git`, `.ssh`) out of the library.
  if (seg.startsWith(".")) {
    throw new Error(`collection path '${path}' segment '${seg}' must not start with '.'`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(seg)) {
    throw new Error(
      `collection path '${path}' segment '${seg}' contains disallowed characters (allowed: A-Z a-z 0-9 . _ -)`,
    );
  }
}

/**
 * A grant pattern — a value the user (or manifest) puts in `collections[]`.
 * Same rules as a concrete path, except `*` and `**` are allowed segments.
 *
 * Examples:
 *   "notes"         valid
 *   "messages/**"   valid (matches messages and any descendant)
 *   "feeds/*"       valid (matches direct children only)
 *   ""              invalid (empty)
 *   "../*"          invalid (.. segment)
 *   "messages/[bad" invalid (bracket not closed → picomatch literal trap)
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
    validateSegment(seg, pattern);
  }
  // Catch unclosed picomatch metacharacters that would silently fall back to
  // literal-match — typo'd patterns should fail at install, not at promote.
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
