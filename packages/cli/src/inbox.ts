import { Queue } from "./queue";

/**
 * Watch-plugin inbox — a thin wrapper over a `Queue<WatchTarget>`. Each
 * chokidar event (or backfill walk row) becomes one NDJSON line:
 *
 *   {"path":"/abs/path.md","mtime":"2026-05-13T12:34:56.789Z"}
 *
 * All durability — atomic claim (rename pending→inflight), dedup, ack/restore
 * lease, orphan recovery — lives in the Queue. This module only fixes the
 * inbox's storage shape: a per-plugin append-log under `inboxes/`, the lease
 * under `inflight/` (its established on-disk layout — a sibling dir, not
 * `inboxes/inflight/`), deduped by `path` keeping the **latest mtime**.
 *
 * The function names/signatures are kept so `plugin-run.ts` / `watcher.ts`
 * don't change: `claimInbox` = `queue.claim`, `clearInflight` = `queue.ack`,
 * `restoreInflight` = `queue.restore`, `recoverOrphanInflight` =
 * `queue.recoverAll`.
 */

export interface WatchTarget {
  path: string;
  mtime: string;
}

/**
 * Dedup by path keeping the latest mtime. Lexicographic compare on ISO-8601 is
 * correct ordering for absolute UTC timestamps — last-appended is *not* enough,
 * a restored-then-re-touched file must surface its newer mtime.
 */
const queue = new Queue<WatchTarget>({
  dir: "inboxes",
  ext: "ndjson",
  shape: "log",
  inflightDir: "inflight",
  key: (t) => t.path,
  prefer: (a, b) => (b.mtime > a.mtime ? b : a),
});

export async function appendToInbox(plugin: string, target: WatchTarget): Promise<void> {
  await queue.enqueue(plugin, target);
}

/**
 * Atomically lease the inbox to inflight, read + dedup, return the targets.
 * New appends recreate the inbox and are picked up by the next claim. The
 * lease is the at-least-once safety net: a crash leaves it on disk, and
 * `restoreInflight` / `recoverOrphanInflight` re-queue it so nothing is lost.
 */
export async function claimInbox(plugin: string): Promise<WatchTarget[]> {
  return queue.claim(plugin);
}

/** Drop the inflight lease after a clean run. */
export async function clearInflight(plugin: string): Promise<void> {
  await queue.ack(plugin);
}

/** Re-queue inflight rows back to the inbox after a non-clean exit. */
export async function restoreInflight(plugin: string): Promise<void> {
  await queue.restore(plugin);
}

/**
 * Restore every orphan inflight file left by a crashed prior daemon. Returns
 * the recovered plugin names.
 */
export async function recoverOrphanInflight(): Promise<string[]> {
  return queue.recoverAll();
}

export async function inboxHasItems(plugin: string): Promise<boolean> {
  return (await queue.pendingNames()).includes(plugin);
}
