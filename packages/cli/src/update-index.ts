import { openStore } from "./store";

export interface UpdateSummary {
  collections: number;
  indexed: number;
  updated: number;
}

/**
 * Re-index the qmd store. Single chokepoint, called after plugin promote
 * and via the `dither index update` CLI subcommand.
 *
 * If `collections` is provided, only those collections are rescanned —
 * the rest of the library is left untouched (per the qmd SDK's
 * `update({ collections })` semantics). Pass nothing for a full rescan.
 *
 * Returns zero counts when the library has no collections (subdirs).
 */
export async function updateIndex(collections?: string[]): Promise<UpdateSummary> {
  const store = await openStore();
  if (!store) {
    return { collections: 0, indexed: 0, updated: 0 };
  }
  const result =
    collections && collections.length > 0
      ? await store.update({ collections })
      : await store.update();
  return {
    collections: result.collections ?? 0,
    indexed: result.indexed ?? 0,
    updated: result.updated ?? 0,
  };
}
