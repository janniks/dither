import { FSWatcher, watch } from "chokidar";
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import { appendToInbox, type WatchTarget } from "./inbox";
import type { Emit, Source } from "./queue";
import { advanceWatermark, readWatermark, watchKey } from "./watch-state";
import { resolveWatchPath } from "./watch-paths";

/**
 * File watcher for plugins with a `watch` block. The daemon owns one Watcher
 * across all plugins; `set(entries)` replaces the active set wholesale, like
 * the scheduler.
 *
 * Phase-1 contract: each chokidar event becomes an inbox row (path + mtime),
 * written immediately for durability. A per-plugin debounce timer schedules
 * the fire signal — the runner reads the inbox at fire start, the callback
 * doesn't carry targets. This separates durability (inbox write) from
 * scheduling (debounce timer).
 *
 * Self-trigger suppression: plugins are *also* writers in the entries tree,
 * so we maintain a recently-promoted-paths map (TTL ~2 s). Chokidar events
 * for paths in that map are dropped before the inbox write.
 *
 * Durability across the down-window: chokidar only sees *live* changes, so a
 * file touched while the daemon was down would be lost. As a `Source`, the
 * watcher persists a per-(plugin,collection) mtime watermark (advanced on
 * every live emit) and `recover(emit)` walks the watched collections at boot,
 * re-enqueuing anything newer than the watermark. The inbox dedups by path,
 * so over-enqueueing is harmless — the watermark is the efficiency floor.
 */

export interface WatchEntry {
  name: string;
  collections: string[];
  glob?: string;
}

export type WatchCallback = (name: string) => void | Promise<void>;

export interface WatcherStats {
  count: number;
  entries: Array<{ name: string; collections: string[]; glob: string }>;
}

interface PluginWatcher {
  entry: WatchEntry;
  flushTimer: NodeJS.Timeout | null;
  windowStart: number | null;
  matcher: (path: string) => boolean;
}

const DEFAULT_GLOB = "**/*.md";
const DEBOUNCE_MS = 30_000;
const DEBOUNCE_CAP_MS = 300_000;
const SUPPRESS_TTL_MS = 2_000;

export interface WatcherOptions {
  /** Override the per-burst debounce window (ms). Tests use a small value. */
  debounceMs?: number;
  /** Override the burst-cap window (ms). */
  debounceCapMs?: number;
}

export class Watcher implements Source {
  private fsWatcher: FSWatcher | null = null;
  private plugins = new Map<string, PluginWatcher>();
  private suppress = new Map<string, number>();
  private libraryRoot = "";
  // Monotonic generation token: bumped on every stop()/set() so handlers
  // queued against a prior FSWatcher (whose async close is in flight) can
  // detect they're stale and drop their event.
  private generation = 0;
  private debounceMs: number;
  private debounceCapMs: number;

  constructor(private readonly onFire: WatchCallback, opts: WatcherOptions = {}) {
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.debounceCapMs = opts.debounceCapMs ?? DEBOUNCE_CAP_MS;
  }

  set(libraryRoot: string, entries: readonly WatchEntry[]): void {
    this.stop();
    this.libraryRoot = libraryRoot;
    if (entries.length === 0) return;

    const watchPaths = new Set<string>();
    for (const entry of entries) {
      const matcher = picomatch(entry.glob ?? DEFAULT_GLOB, { dot: false });
      this.plugins.set(entry.name, {
        entry,
        flushTimer: null,
        windowStart: null,
        matcher,
      });
      for (const c of entry.collections) {
        watchPaths.add(resolveWatchPath(libraryRoot, c));
      }
    }

    const gen = this.generation;
    this.fsWatcher = watch(Array.from(watchPaths), {
      ignoreInitial: true,
      persistent: true,
      alwaysStat: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.fsWatcher.on("add", (path, stats) => void this.onChange(gen, path, stats));
    this.fsWatcher.on("change", (path, stats) => void this.onChange(gen, path, stats));
  }

  /**
   * `Source.start` — no-op. The live producer is wired by `set()` (chokidar →
   * inbox append + watermark advance), called from the daemon's reconcile on
   * boot and SIGHUP, and fires through the constructor `onFire`. Nothing to
   * bind here; kept to satisfy the `Source` shape uniformly.
   */
  start(): void {}

  /**
   * `Source.recover` — boot catch-up. For each active watch entry, walk its
   * collections and re-enqueue every file with `mtime > watermark` (changes
   * the watcher missed while the daemon was down), then advance the watermark
   * to the max mtime seen. Requires `set()` to have run first (the daemon's
   * reconcile does this before recover). `emit(name)` nudges the drain for
   * any plugin that got fresh rows.
   */
  async recover(emit: Emit): Promise<void> {
    for (const plugin of this.plugins.values()) {
      let enqueued = false;
      for (const c of plugin.entry.collections) {
        const key = watchKey(plugin.entry.name, c);
        const mark = await readWatermark(key);
        let max = mark;
        for (const t of await walkMd(resolveWatchPath(this.libraryRoot, c))) {
          if (t.mtime <= mark) continue;
          if (!matchesGlob(this.libraryRoot, t.path, plugin.entry.collections, plugin.matcher)) continue;
          await appendToInbox(plugin.entry.name, t);
          enqueued = true;
          if (t.mtime > max) max = t.mtime;
        }
        if (max > mark) await advanceWatermark(key, max);
      }
      if (enqueued) await emit(plugin.entry.name);
    }
  }

  /**
   * Mark a path as recently promoted so the next chokidar event for it gets
   * dropped. Called by the daemon's promote callback to break self-trigger
   * loops (plugin writes file → watcher fires plugin → ...).
   */
  suppressOnce(path: string): void {
    this.suppress.set(path, Date.now() + SUPPRESS_TTL_MS);
  }

  stop(): void {
    this.generation += 1;
    if (this.fsWatcher) {
      void this.fsWatcher.close();
      this.fsWatcher = null;
    }
    for (const p of this.plugins.values()) {
      if (p.flushTimer) clearTimeout(p.flushTimer);
    }
    this.plugins.clear();
    this.suppress.clear();
  }

  stats(): WatcherStats {
    const entries = Array.from(this.plugins.values()).map((p) => ({
      name: p.entry.name,
      collections: p.entry.collections,
      glob: p.entry.glob ?? DEFAULT_GLOB,
    }));
    return { count: entries.length, entries };
  }

  private async onChange(gen: number, path: string, stats: Stats | undefined): Promise<void> {
    // Drop events that arrived after a stop()/set() — they belong to the
    // previous chokidar watcher and would otherwise leak into the new
    // active plugin set's inbox.
    if (gen !== this.generation) return;
    const expiry = this.suppress.get(path);
    if (expiry !== undefined) {
      if (expiry > Date.now()) {
        this.suppress.delete(path);
        return;
      }
      this.suppress.delete(path);
    }
    const now = Date.now();
    for (const [k, v] of this.suppress) {
      if (v <= now) this.suppress.delete(k);
    }

    // chokidar's `alwaysStat: true` usually provides Stats; fall back to a
    // syscall if it's somehow missing. Either way, mtime is what reaches
    // the inbox.
    const mtimeMs = stats?.mtimeMs ?? (await stat(path).catch(() => null))?.mtimeMs;
    if (mtimeMs === undefined) return;
    const mtime = new Date(mtimeMs).toISOString();

    for (const plugin of this.plugins.values()) {
      if (!matchesAnyCollection(this.libraryRoot, path, plugin.entry.collections)) continue;
      const relative = relativeToCollections(this.libraryRoot, path, plugin.entry.collections);
      if (relative === null) continue;
      if (!plugin.matcher(relative)) continue;

      await appendToInbox(plugin.entry.name, { path, mtime });
      // Best-effort: the watermark is a re-derivable efficiency floor (a lost
      // advance only costs one redundant, inbox-deduped re-enqueue next boot),
      // and a late event racing a stop()/teardown shouldn't crash the watcher.
      await advanceWatermark(
        watchKey(plugin.entry.name, collectionOf(this.libraryRoot, path, plugin.entry.collections)),
        mtime,
      ).catch(() => undefined);
      if (plugin.windowStart === null) plugin.windowStart = Date.now();
      this.scheduleFlush(plugin);
    }
  }

  private scheduleFlush(plugin: PluginWatcher): void {
    if (plugin.flushTimer) clearTimeout(plugin.flushTimer);
    const windowAge = plugin.windowStart === null ? 0 : Date.now() - plugin.windowStart;
    const remainingCap = Math.max(0, this.debounceCapMs - windowAge);
    const wait = Math.min(this.debounceMs, remainingCap);

    plugin.flushTimer = setTimeout(() => {
      plugin.windowStart = null;
      plugin.flushTimer = null;
      void this.onFire(plugin.entry.name);
    }, wait);
  }
}

function matchesAnyCollection(root: string, path: string, collections: string[]): boolean {
  for (const c of collections) {
    const base = resolveWatchPath(root, c);
    if (path === base || path.startsWith(`${base}/`)) return true;
  }
  return false;
}

function relativeToCollections(root: string, path: string, collections: string[]): string | null {
  for (const c of collections) {
    const prefix = `${resolveWatchPath(root, c)}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return null;
}

/** The collection entry whose resolved dir contains `path` (watermark key). */
function collectionOf(root: string, path: string, collections: string[]): string {
  for (const c of collections) {
    const base = resolveWatchPath(root, c);
    if (path === base || path.startsWith(`${base}/`)) return c;
  }
  return collections[0] ?? "";
}

/** Does a recovered path pass a plugin's glob (relative to its collections)? */
function matchesGlob(
  root: string,
  path: string,
  collections: string[],
  matcher: (p: string) => boolean,
): boolean {
  const relative = relativeToCollections(root, path, collections);
  return relative !== null && matcher(relative);
}

/** Recursively collect `.md` files under `dir` as inbox targets. ENOENT → []. */
async function walkMd(dir: string): Promise<WatchTarget[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return (
    await Promise.all(
      entries.map(async (name) => {
        const full = join(dir, name);
        const s = await stat(full).catch(() => null);
        if (!s) return [];
        if (s.isDirectory()) return walkMd(full);
        if (s.isFile() && name.endsWith(".md")) {
          return [{ path: full, mtime: new Date(s.mtimeMs).toISOString() }];
        }
        return [];
      }),
    )
  ).flat();
}
