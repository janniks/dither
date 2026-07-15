import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { watchStatePath } from "./paths";

/**
 * Per-(plugin,collection) mtime watermark — the watcher's durability layer for
 * the down-window gap. The inbox dedups by path, so re-enqueueing a file is
 * always safe; the watermark is the efficiency+correctness floor that lets
 * boot catch-up enqueue only files changed since the daemon last saw the
 * collection.
 *
 *   <config>/watch-state/<plugin>__<safe-collection>.json = { watermark: "<ISO>" }
 *
 * `watermark` is the max mtime (ISO-8601) the watcher has emitted for that key.
 * ISO-8601 lexicographic order is correct for absolute UTC timestamps, matching
 * the inbox's dedup compare.
 */

interface WatchState {
  watermark: string;
}

/** Filesystem-safe key for a (plugin, collection) pair. */
export function watchKey(plugin: string, collection: string): string {
  const safe = collection.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${plugin}__${safe}`;
}

/** Read the watermark, or `""` when none has been recorded yet. */
export async function readWatermark(key: string): Promise<string> {
  try {
    const raw = await readFile(watchStatePath(key), "utf-8");
    return (JSON.parse(raw) as WatchState).watermark ?? "";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Advance the watermark to `mtime` when it's newer than what's stored.
 * Monotonic — an out-of-order (older) emit never lowers it.
 */
export async function advanceWatermark(key: string, mtime: string): Promise<void> {
  if (mtime <= (await readWatermark(key))) return;
  const file = watchStatePath(key);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ watermark: mtime } satisfies WatchState));
  await rename(tmp, file);
}
