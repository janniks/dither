import { openStore } from "./store";
import { acquireTheme, releaseTheme } from "./locks";
import { requestReindexSync } from "./markers";

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
/**
 * `updateIndex` under the `qmd-index` lock, for callers whose own work
 * already succeeded (config saved) before the rescan. Lock busy → defer
 * via the needs-reindex marker and print the uniform busy note; the
 * daemon's next reconcile catches up. A thrown rescan is warned, not
 * rethrown — a stale index recovers on the next `index update`.
 */
export async function reindex(collections?: string[]): Promise<void> {
  const handle = await acquireTheme("index");
  if (handle === null) {
    requestReindexSync();
    console.warn("[dither] qmd is busy indexing — reindex queued for the daemon's next pass");
    return;
  }
  try {
    await updateIndex(collections);
  } catch (err) {
    console.warn(
      `[dither] saved, but reindex failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await releaseTheme(handle);
  }
}

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
