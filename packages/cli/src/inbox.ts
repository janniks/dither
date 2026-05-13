import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inboxPath, inflightPath, inflightDir } from "./home";

/**
 * Watch-plugin inbox: per-plugin append-only NDJSON. Each chokidar event
 * (or backfill walk row) becomes one line:
 *
 *   {"path":"/abs/path.md","mtime":"2026-05-13T12:34:56.789Z"}
 *
 * Duplicate paths are permitted in the file. Dedup happens at claim time
 * (latest mtime wins). Append is O(1); claim is O(n) and runs once per
 * fire — bounded by debounce window, not chokidar event rate.
 *
 * Phase 1: no inflight, no atomic claim — just read-then-truncate. Phase 2
 * will introduce the inflight sidecar + atomic move.
 */

export interface WatchTarget {
  path: string;
  mtime: string;
}

export async function appendToInbox(plugin: string, target: WatchTarget): Promise<void> {
  const file = inboxPath(plugin);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(target)}\n`);
}

async function readInbox(plugin: string): Promise<WatchTarget[]> {
  let raw: string;
  try {
    raw = await readFile(inboxPath(plugin), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: WatchTarget[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as WatchTarget;
      if (typeof row?.path === "string" && typeof row?.mtime === "string") out.push(row);
    } catch {
      // skip malformed rows — at-least-once delivery means we tolerate a
      // partial-write tail. Plugins re-discover via the next chokidar event.
    }
  }
  return out;
}

/**
 * Dedup by path, keeping the latest mtime (lexicographic compare on ISO-8601
 * is correct ordering for absolute UTC timestamps).
 */
function dedup(rows: WatchTarget[]): WatchTarget[] {
  const latest = new Map<string, WatchTarget>();
  for (const r of rows) {
    const prev = latest.get(r.path);
    if (!prev || r.mtime > prev.mtime) latest.set(r.path, r);
  }
  return Array.from(latest.values());
}

/**
 * Read the inbox, dedup, write the result to inflight, then truncate the
 * inbox. Inflight is the at-least-once safety net: if the plugin crashes
 * or the daemon dies, inflight survives on disk; on next startup or run-
 * result, inflight gets restored to the inbox so nothing is lost.
 *
 * Race note: between read and truncate, new chokidar events could append
 * to the inbox. We accept a tiny window where a row appended after our
 * read but before our rename gets clobbered. Closing that fully would
 * require fs-level locking; for personal-scale workloads it's not worth
 * the complexity — the next chokidar event will surface the same path
 * again.
 */
export async function claimInbox(plugin: string): Promise<WatchTarget[]> {
  const rows = await readInbox(plugin);
  if (rows.length === 0) return [];
  const deduped = dedup(rows);

  // Write inflight first, then truncate inbox. Crash between → orphan
  // inflight; daemon startup recovery handles it.
  const inflight = inflightPath(plugin);
  await mkdir(dirname(inflight), { recursive: true });
  await writeFile(inflight, deduped.map((r) => `${JSON.stringify(r)}\n`).join(""));

  const file = inboxPath(plugin);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, "");
  await rename(tmp, file);

  return deduped;
}

/** Delete the inflight file. Called after a clean run. */
export async function clearInflight(plugin: string): Promise<void> {
  try {
    await unlink(inflightPath(plugin));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Append the inflight rows back to the inbox, then delete inflight. Called
 * after a non-clean exit (or on daemon startup for orphan inflight files).
 * The append is plain — no dedup, no ordering preservation; the next
 * `claimInbox()` deduplicates everything by path.
 */
export async function restoreInflight(plugin: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(inflightPath(plugin), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (raw.length > 0) {
    const file = inboxPath(plugin);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, raw);
  }
  await unlink(inflightPath(plugin)).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}

/**
 * Scan the inflight dir for orphan files (plugin name doesn't matter — any
 * inflight file at daemon start means the previous run didn't get to clear
 * or restore it). Restore each. Returns the list of plugins recovered.
 */
export async function recoverOrphanInflight(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(inflightDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const f of entries) {
    if (!f.endsWith(".ndjson")) continue;
    const plugin = f.slice(0, -".ndjson".length);
    await restoreInflight(plugin);
    out.push(plugin);
  }
  return out;
}

export async function inboxHasItems(plugin: string): Promise<boolean> {
  const rows = await readInbox(plugin);
  return rows.length > 0;
}
