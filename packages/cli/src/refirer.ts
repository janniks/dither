import { listRefires, type RefireRow } from "./refire";

/**
 * One-shot timer registry for refire rows persisted on disk. Owns one
 * setTimeout per pending refire and fires the callback when each elapses.
 *
 * Symmetric with `Scheduler` (cron entries) and `Watcher` (chokidar events)
 * — three separate fire sources that all funnel back into `fireWithSuppress`.
 */

export type RefireCallback = (name: string) => void | Promise<void>;

export class Refirer {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly onFire: RefireCallback) {}

  /**
   * Read all persisted refire rows and schedule a timer for each non-
   * suspended one. Called at daemon startup and on SIGHUP reload.
   */
  async reload(): Promise<void> {
    this.stop();
    const rows = await listRefires();
    for (const { plugin, row } of rows) {
      if (row.suspended) continue;
      this.scheduleAt(plugin, Date.parse(row.fireAt));
    }
  }

  /** Add / replace a refire timer for one plugin. */
  set(plugin: string, fireAtMs: number): void {
    this.cancel(plugin);
    this.scheduleAt(plugin, fireAtMs);
  }

  cancel(plugin: string): void {
    const t = this.timers.get(plugin);
    if (t) {
      clearTimeout(t);
      this.timers.delete(plugin);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  stats(): { count: number; entries: Array<{ plugin: string; fireInMs: number }> } {
    const now = Date.now();
    const entries: Array<{ plugin: string; fireInMs: number }> = [];
    // setTimeout doesn't expose its scheduled time; we only know plugins
    // with active timers. Daemons that want detail should listRefires().
    for (const plugin of this.timers.keys()) entries.push({ plugin, fireInMs: -1 });
    return { count: this.timers.size, entries };
  }

  private scheduleAt(plugin: string, fireAtMs: number): void {
    const delay = Math.max(0, fireAtMs - Date.now());
    const t = setTimeout(() => {
      this.timers.delete(plugin);
      void this.onFire(plugin);
    }, delay);
    // Don't keep the event loop alive solely on refire timers.
    t.unref?.();
    this.timers.set(plugin, t);
  }
}

export type { RefireRow };
