import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createStore, type QMDStore, type Collection } from "@tobilu/qmd";
import { entriesDir, indexDbPath } from "./home";

/**
 * Open a qmd store over `~/.dither/entries/`. Each top-level subdirectory
 * is registered as a collection. Returns null if no collections exist.
 */
export async function openStore(): Promise<QMDStore | null> {
  const root = entriesDir();
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
