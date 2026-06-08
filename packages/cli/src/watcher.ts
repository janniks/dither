import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import { appendToInbox, type WatchTarget } from "./inbox";
import type { Emit, Source } from "./queue";
import { advanceWatermark, readWatermark, watchKey } from "./watch-state";
import { resolveWatchPath } from "./watch-paths";
import { watchTree, type TreeWatch } from "./watch-tree";

/**
 * File watcher for plugins with a `watch` block. The daemon owns one Watcher
 * across all plugins; `set(entries)` replaces the active set wholesale, like
 * the scheduler.
 *
 * Live producer: `watch-tree` (native `fs.watch`) reports each add/change as
 * an inbox row (path + mtime), written immediately for durability. A per-plugin
 * debounce timer schedules the fire signal — the runner reads the inbox at fire
 * start, the callback doesn't carry targets. This separates durability (inbox
 * write) from scheduling (debounce timer).
 *
 * Self-trigger suppression: plugins are *also* writers in the entries tree,
 * so we maintain a recently-promoted-paths map (TTL ~2 s). Watch events for
 * paths in that map are dropped before the inbox write.
 *
 * Durability across the down-window: the live watcher only sees changes while
 * running, so a file touched while the daemon was down would be lost. As a
 * `Source`, the watcher persists a per-(plugin,collection) mtime watermark
 * (advanced on every live emit) and `recover(emit)` walks the watched
 * collections at boot, re-enqueuing anything newer than the watermark. The
 * inbox dedups by path, so over-enqueueing is harmless — the watermark is the
 * efficiency floor.
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
  private tree: TreeWatch | null = null;
  private plugins = new Map<string, PluginWatcher>();
  private roots: string[] = [];
  private suppress = new Map<string, number>();
  private libraryRoot = "";
  // Monotonic generation token: bumped on every stop()/set() so events
  // queued against a prior watch-tree can detect they're stale and drop.
  private generation = 0;
  private debounceMs: number;
  private debounceCapMs: number;

  constructor(private readonly onFire: WatchCallback, opts: WatcherOptions = {}) {
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.debounceCapMs = opts.debounceCapMs ?? DEBOUNCE_CAP_MS;
  }

  /**
   * Register the active watch entries and resolve their collection roots. Does
   * NOT open the live watcher — that's `start()`, per the `Source` contract, so
   * `recover()` can run a clean boot scan without the live producer racing it.
   */
  set(libraryRoot: string, entries: readonly WatchEntry[]): void {
    this.stop();
    this.libraryRoot = libraryRoot;
    if (entries.length === 0) return;

    const roots = new Set<string>();
    for (const entry of entries) {
      const matcher = picomatch(entry.glob ?? DEFAULT_GLOB, { dot: false });
      this.plugins.set(entry.name, {
        entry,
        flushTimer: null,
        windowStart: null,
        matcher,
      });
      for (const c of entry.collections) {
        roots.add(resolveWatchPath(libraryRoot, c));
      }
    }
    this.roots = Array.from(roots);
  }

  /**
   * `Source.start` — open the live producer: a watch-tree over the resolved
   * collection roots, routing every add/change into `onChange` (inbox append +
   * watermark advance + debounced fire). The daemon calls this after `set()` on
   * boot and SIGHUP. Idempotent-ish: a prior tree is closed by `set()`/`stop()`.
   */
  start(): void {
    if (this.roots.length === 0) return;
    const gen = this.generation;
    this.tree = watchTree(this.roots, (path) => void this.onChange(gen, path));
  }

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
   * Mark a path as recently promoted so the next watch event for it gets
   * dropped. Called by the daemon's promote callback to break self-trigger
   * loops (plugin writes file → watcher fires plugin → ...).
   */
  suppressOnce(path: string): void {
    this.suppress.set(path, Date.now() + SUPPRESS_TTL_MS);
  }

  stop(): void {
    this.generation += 1;
    if (this.tree) {
      this.tree.close();
      this.tree = null;
    }
    for (const p of this.plugins.values()) {
      if (p.flushTimer) clearTimeout(p.flushTimer);
    }
    this.plugins.clear();
    this.roots = [];
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

  private async onChange(gen: number, path: string): Promise<void> {
    // Drop events that arrived after a stop()/set() — they belong to the
    // previous watch-tree and would otherwise leak into the new active
    // plugin set's inbox.
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

    // watch-tree carries only the path; stat for the mtime that reaches the
    // inbox. A vanished file (stat fails) is a deletion — drop it.
    const mtimeMs = (await stat(path).catch(() => null))?.mtimeMs;
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
