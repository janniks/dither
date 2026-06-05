import { listRefires } from "./refire";
import type { Emit, Source } from "./queue";

/**
 * One-shot timer registry for refire rows persisted on disk. Owns one
 * setTimeout per pending refire and fires the callback when each elapses.
 *
 * A `Source` like `Scheduler` and `Watcher`, and shaped identically: `start`
 * is a no-op (live rows are armed by `set()` after each run via
 * `fireWithSuppress`), `recover` re-arms a timer per non-suspended persisted
 * row at boot / SIGHUP (`reload`). Each timer funnels back into `onFire`
 * (`fireWithSuppress`); `emit` is vestigial, as it is for the other two
 * sources whose live producer fires through the constructor callback.
 */

export type RefireCallback = (name: string) => void | Promise<void>;

export class Refirer implements Source {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly onFire: RefireCallback) {}

  /**
   * Read all persisted refire rows and schedule a timer for each non-
   * suspended one. Shared by `start` (boot/SIGHUP wiring) and `recover`.
   */
  async reload(): Promise<void> {
    this.stop();
    const rows = await listRefires();
    for (const { plugin, row } of rows) {
      if (row.suspended) continue;
      this.scheduleAt(plugin, Date.parse(row.fireAt));
    }
  }

  /**
   * `Source.start` — no-op. Live rows are armed by `set()` after each run
   * (`fireWithSuppress` reads the row a finishing plugin wrote). Kept to
   * satisfy the `Source` shape, like Scheduler/Watcher.
   */
  start(_emit: Emit): void {}

  /** `Source.recover` — boot/SIGHUP re-arm of the persisted rows. */
  async recover(_emit: Emit): Promise<void> {
    await this.reload();
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
    if (!Number.isFinite(fireAtMs)) {
      console.error(`refirer: skipping '${plugin}' — invalid fireAt`);
      return;
    }
    const remaining = Math.max(0, fireAtMs - Date.now());
    const delay = Math.min(remaining, MAX_TIMER_MS);
    const t = setTimeout(() => {
      this.timers.delete(plugin);
      if (delay < remaining) {
        this.scheduleAt(plugin, fireAtMs);
        return;
      }
      void this.onFire(plugin);
    }, delay);
    // Don't keep the event loop alive solely on refire timers.
    t.unref?.();
    this.timers.set(plugin, t);
  }
}

// Node represents setTimeout delays as a 32-bit signed int (ms). Anything
// larger overflows and fires immediately. Chunk longer waits into hops of
// this size and reschedule until fireAt is reached.
const MAX_TIMER_MS = 0x7fffffff;
