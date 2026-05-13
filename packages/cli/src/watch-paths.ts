import { isAbsolute, join } from "node:path";

/**
 * Resolve a `watch.collections` entry to an absolute filesystem path.
 * Shared between the daemon's Watcher and the backfill CLI so both
 * agree on what each manifest string means.
 *
 *   "github"                 → <library>/github          (collection)
 *   "github/repositories"    → <library>/github/repositories
 *   "./foo"                  → <library>/foo             (library-relative)
 *   "/abs/path"              → /abs/path                 (absolute)
 */
export function resolveWatchPath(libraryRoot: string, entry: string): string {
  if (isAbsolute(entry)) return entry;
  if (entry.startsWith("./")) return join(libraryRoot, entry.slice(2));
  return join(libraryRoot, entry);
}
