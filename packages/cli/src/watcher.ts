import { FSWatcher, watch } from "chokidar";
import { join } from "node:path";
import picomatch from "picomatch";

/**
 * File watcher for plugins with a `watch` block. The daemon owns one Watcher
 * across all plugins; `set(entries)` replaces the active set wholesale, like
 * the scheduler. Each plugin's events are coalesced through a per-plugin
 * debounce — bursts of N file changes within the window become one fire,
 * carrying every changed path in `input.json.targets`.
 *
 * Self-trigger suppression: plugins are *also* writers in the entries tree,
 * so we maintain a recently-promoted-paths map (TTL ~2 s). Chokidar events
 * for paths in that map are dropped before they reach the debounce.
 */

export interface WatchEntry {
  name: string;
  collections: string[];
  glob?: string;
}

export type WatchCallback = (name: string, targets: string[]) => void | Promise<void>;

export interface WatcherStats {
  count: number;
  entries: Array<{ name: string; collections: string[]; glob: string }>;
}

interface PluginWatcher {
  entry: WatchEntry;
  pendingTargets: Set<string>;
  flushTimer: NodeJS.Timeout | null;
  windowStart: number | null;
  matcher: (path: string) => boolean;
}

const DEFAULT_GLOB = "**/*.md";
const DEBOUNCE_MS = 5_000;
const DEBOUNCE_CAP_MS = 30_000;
const SUPPRESS_TTL_MS = 2_000;

export class Watcher {
  private fsWatcher: FSWatcher | null = null;
  private plugins = new Map<string, PluginWatcher>();
  private suppress = new Map<string, number>();
  private libraryRoot = "";

  constructor(private readonly onFire: WatchCallback) {}

  set(libraryRoot: string, entries: readonly WatchEntry[]): void {
    this.stop();
    this.libraryRoot = libraryRoot;
    if (entries.length === 0) return;

    const entriesRoot = libraryRoot;
    const watchPaths = new Set<string>();
    for (const entry of entries) {
      const matcher = picomatch(entry.glob ?? DEFAULT_GLOB, { dot: false });
      this.plugins.set(entry.name, {
        entry,
        pendingTargets: new Set(),
        flushTimer: null,
        windowStart: null,
        matcher,
      });
      for (const c of entry.collections) {
        watchPaths.add(join(entriesRoot, c));
      }
    }

    this.fsWatcher = watch(Array.from(watchPaths), {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.fsWatcher.on("add", (path) => this.onChange(path));
    this.fsWatcher.on("change", (path) => this.onChange(path));
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

  private onChange(path: string): void {
    const expiry = this.suppress.get(path);
    if (expiry !== undefined) {
      if (expiry > Date.now()) {
        this.suppress.delete(path);
        return;
      }
      this.suppress.delete(path);
    }
    // Garbage-collect stale suppression entries opportunistically.
    if (this.suppress.size > 64) {
      const now = Date.now();
      for (const [k, v] of this.suppress) {
        if (v <= now) this.suppress.delete(k);
      }
    }

    for (const plugin of this.plugins.values()) {
      if (!matchesAnyCollection(this.libraryRoot, path, plugin.entry.collections)) continue;
      const relative = relativeToCollections(this.libraryRoot, path, plugin.entry.collections);
      if (relative === null) continue;
      if (!plugin.matcher(relative)) continue;

      plugin.pendingTargets.add(path);
      if (plugin.windowStart === null) plugin.windowStart = Date.now();
      this.scheduleFlush(plugin);
    }
  }

  private scheduleFlush(plugin: PluginWatcher): void {
    if (plugin.flushTimer) clearTimeout(plugin.flushTimer);
    const windowAge = plugin.windowStart === null ? 0 : Date.now() - plugin.windowStart;
    const remainingCap = Math.max(0, DEBOUNCE_CAP_MS - windowAge);
    const wait = Math.min(DEBOUNCE_MS, remainingCap);

    plugin.flushTimer = setTimeout(() => {
      const targets = Array.from(plugin.pendingTargets);
      plugin.pendingTargets.clear();
      plugin.windowStart = null;
      plugin.flushTimer = null;
      if (targets.length === 0) return;
      void this.onFire(plugin.entry.name, targets);
    }, wait);
  }
}

function matchesAnyCollection(root: string, path: string, collections: string[]): boolean {
  for (const c of collections) {
    const prefix = `${join(root, c)}/`;
    if (path.startsWith(prefix) || path === join(root, c)) return true;
  }
  return false;
}

function relativeToCollections(root: string, path: string, collections: string[]): string | null {
  for (const c of collections) {
    const prefix = `${join(root, c)}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return null;
}
