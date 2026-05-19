import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createStore, type QMDStore, type Collection } from "@tobilu/qmd";
import { assertInitialized } from "./config";
import { indexDbPath } from "./home";

/**
 * Open a qmd store over every collection dither knows about — library
 * top-level subdirs plus every registered external mount. Each is
 * registered with the `**\/*.md` pattern so nestable-collections
 * recursion works uniformly. Externals whose paths are missing at open
 * time are warned-and-skipped rather than failing the whole open. Returns
 * null if the union is empty.
 */
export async function openStore(): Promise<QMDStore | null> {
  const cfg = await assertInitialized();
  const root = cfg.library.path;
  // mkdir is intentionally permissive: if the configured library was
  // physically moved (`mv X Y`) after init, we silently recreate an empty
  // X here and search will return no results. The realpath
  // canonicalisation at init covers symlink-swap but not literal-move.
  // See notes/qmd-library-edge-cases.md (#2).
  mkdirSync(root, { recursive: true });

  const collections: Record<string, Collection> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collections[entry.name] = { path: join(root, entry.name), pattern: "**/*.md" };
    }
  }

  // Externals are layered on top. A name collision with a library subdir
  // is prevented at `collection add` time, so a key clash here would mean
  // someone hand-edited config.json; we let the external win as a
  // last-write-wins debugging convenience.
  for (const ext of cfg.collections.external) {
    try {
      if (!statSync(ext.path).isDirectory()) {
        console.warn(`[dither] external collection '${ext.name}' path is not a directory: ${ext.path} — skipping`);
        continue;
      }
    } catch {
      console.warn(`[dither] external collection '${ext.name}' is missing at ${ext.path} — skipping`);
      continue;
    }
    collections[ext.name] = { path: ext.path, pattern: "**/*.md" };
  }

  if (Object.keys(collections).length === 0) {
    return null;
  }

  return await createStore({
    dbPath: indexDbPath(),
    config: { collections },
  });
}
