import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createStore, type QMDStore, type Collection } from "@tobilu/qmd";
import { indexDbPath } from "./home";
import { libraryRoot } from "./paths";

/**
 * Open a qmd store over the configured library. Each top-level subdirectory
 * of the library is registered as a qmd collection (mirror approach).
 * Returns null if the library has no collections (subdirs).
 */
export async function openStore(): Promise<QMDStore | null> {
  const root = await libraryRoot();
  // mkdir is intentionally permissive: if the configured library was
  // physically moved (`mv X Y`) after init, we silently recreate an empty
  // X here and search will return no results. The realpath
  // canonicalisation at init covers symlink-swap but not literal-move.
  // See notes/qmd-library-edge-cases.md (#2).
  mkdirSync(root, { recursive: true });

  const collections: Record<string, Collection> = {};
  for (const name of readdirSync(root)) {
    const fullPath = join(root, name);
    if (statSync(fullPath).isDirectory()) {
      collections[name] = { path: fullPath, pattern: "**/*.md" };
    }
  }

  if (Object.keys(collections).length === 0) {
    return null;
  }

  return await createStore({
    dbPath: indexDbPath(),
    config: { collections },
  });
}
