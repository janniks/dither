import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inboxPath } from "./home";

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
 * Atomically read the inbox + truncate it. Returns the deduped set of
 * targets. Used at fire start.
 *
 * Race note: between read and truncate, new chokidar events could append
 * to the inbox. We mitigate by writing an empty file via temp+rename and
 * only deduping what was in the file at read time. Newly-appended rows
 * survive in the inbox for the next fire. We accept a tiny window where
 * an event appended after our read but before our rename gets clobbered;
 * Phase 2's inflight model closes this fully.
 */
export async function claimInbox(plugin: string): Promise<WatchTarget[]> {
  const rows = await readInbox(plugin);
  if (rows.length === 0) return [];
  const file = inboxPath(plugin);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, "");
  await rename(tmp, file);
  return dedup(rows);
}

export async function inboxHasItems(plugin: string): Promise<boolean> {
  const rows = await readInbox(plugin);
  return rows.length > 0;
}
