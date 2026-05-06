import picomatch from "picomatch";

/**
 * Validate a *concrete* collection path — the value a plugin puts in
 * frontmatter `collection` and the host stores under `~/.dither/entries/`.
 *
 * Rules (per spec `nestable-collections`):
 *   - non-empty
 *   - per segment: [a-zA-Z0-9._-]+
 *   - segments separated by single `/`, no leading/trailing `/`, no empty segments
 *   - no `..` segment anywhere
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
    if (seg === "..") {
      throw new Error(`collection path '${path}' must not contain '..'`);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(seg)) {
      throw new Error(
        `collection path '${path}' segment '${seg}' contains disallowed characters (allowed: A-Z a-z 0-9 . _ -)`,
      );
    }
  }
}

const matcherCache = new Map<string, (s: string) => boolean>();

function compile(glob: string): (s: string) => boolean {
  let m = matcherCache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    matcherCache.set(glob, m);
  }
  return m;
}

/**
 * Returns true iff at least one glob in `grants` matches `collection`.
 * Standard picomatch semantics: `messages/**` matches descendants but not
 * `messages` itself; `messages/*` is direct children only; `messages` is exact.
 *
 * `grants` are not validated as paths (they may legitimately contain `*` and
 * `**`); the *target* `collection` is validated by callers separately.
 */
export function grantsCover(grants: readonly string[], collection: string): boolean {
  for (const g of grants) {
    if (compile(g)(collection)) return true;
  }
  return false;
}
