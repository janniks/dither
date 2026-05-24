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
 * Claim atomically moves the inbox to inflight before reading, so appends
 * during a claim land in a fresh inbox and survive for the next fire.
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

async function readRows(file: string): Promise<WatchTarget[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // At-least-once delivery: a partial-write tail row gets dropped here
  // (parseOrNull → null) and the watcher re-discovers it on the next event.
  return raw
    .split("\n")
    .flatMap((line) => {
      if (!line) return [];
      const row = parseOrNull(line);
      if (!row || typeof row.path !== "string" || typeof row.mtime !== "string") return [];
      return [row as unknown as WatchTarget];
    });
}

function parseOrNull(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readInbox(plugin: string): Promise<WatchTarget[]> {
  return readRows(inboxPath(plugin));
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
 * Atomically move the inbox to inflight, read it, then dedup inflight. New
 * appends recreate the inbox path and are picked up by the next claim.
 * Inflight is the at-least-once safety net: if the plugin crashes or the
 * daemon dies, inflight survives on disk; on next startup or run-result,
 * inflight gets restored to the inbox so nothing is lost.
 */
export async function claimInbox(plugin: string): Promise<WatchTarget[]> {
  const file = inboxPath(plugin);
  const inflight = inflightPath(plugin);
  await mkdir(dirname(file), { recursive: true });
  await mkdir(dirname(inflight), { recursive: true });

  try {
    await rename(file, inflight);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const rows = await readRows(inflight);
  if (rows.length === 0) {
    await unlink(inflight).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
    return [];
  }
  const deduped = dedup(rows);
  const tmp = `${inflight}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, deduped.map((r) => `${JSON.stringify(r)}\n`).join(""));
  await rename(tmp, inflight);

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
