import { openStore } from "./store";

export interface UpdateSummary {
  collections: number;
  indexed: number;
  updated: number;
}

/**
 * Re-index all configured collections. Single chokepoint for keeping
 * the qmd index fresh — called after plugin promote and via the
 * `dither index update` CLI subcommand.
 *
 * Returns zero counts when there are no collections (i.e. the entries
 * dir is missing or contains no subdirectories).
 */
export async function updateIndex(): Promise<UpdateSummary> {
  const store = await openStore();
  if (!store) {
    return { collections: 0, indexed: 0, updated: 0 };
  }
  const result = await store.update();
  return {
    collections: result.collections ?? 0,
    indexed: result.indexed ?? 0,
    updated: result.updated ?? 0,
  };
}
