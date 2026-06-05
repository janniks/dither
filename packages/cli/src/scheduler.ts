import { Cron } from "croner";
import type { Emit, Source } from "./queue";
import { advanceLastRun, readLastRun } from "./schedule-state";
import { parseSchedule } from "./schedule-parser";

/**
 * Wraps croner with the `set(entries)` semantics the daemon needs: a single
 * call replaces the active set wholesale. Reload is reconcile-by-replace —
 * we cancel old jobs and register the new set in one step. Schedules are
 * keyed by plugin name; if two entries name the same plugin the last wins.
 *
 * Each fire calls back into `onFire(name)`. The scheduler does not import
 * `runPlugin` directly — that keeps a tight unit-testable boundary and lets
 * the daemon decide how to wire the actual run (e.g. with shutdown gating).
 *
 * Durability across the down-window: croner is in-memory, so a tick due while
 * the daemon was down would be silently dropped. As a `Source`, the scheduler
 * persists a per-plugin `lastRun` (advanced on every live fire) and
 * `recover(emit)` asks croner whether each pattern would have fired between
 * `lastRun` and now — if so it fires once (anacron-style; N missed ticks
 * collapse to one). A fresh schedule (empty `lastRun`) does NOT catch-up-fire;
 * it just initializes `lastRun = now` so a brand-new install doesn't
 * immediately fire everything.
 */

export interface ScheduleEntry {
  name: string;
  schedule: string;
}

export type FireCallback = (name: string) => void | Promise<void>;

export interface SchedulerStats {
  count: number;
  entries: Array<{ name: string; pattern: string; nextRun: string | null }>;
}

export class Scheduler implements Source {
  private jobs = new Map<string, Cron>();

  constructor(private readonly onFire: FireCallback) {}

  set(entries: readonly ScheduleEntry[]): void {
    // Stop everything first; replacement is the simplest way to be sure no
    // stale fires can land between the cancel and the new register.
    this.stop();

    for (const entry of entries) {
      let pattern: string;
      try {
        pattern = parseSchedule(entry.schedule);
      } catch (err) {
        // Malformed schedule for one plugin shouldn't take down the rest.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`scheduler: skipping '${entry.name}' — ${message}`);
        continue;
      }

      try {
        // Live tick: record lastRun, then fire. Persisting first means a
        // crash mid-fire still advances the watermark, so boot recover won't
        // double-fire a tick we already started (at-least-once stays at-least
        // — the run itself is transactional, so a rare redo is safe).
        const job = new Cron(pattern, () => {
          void advanceLastRun(entry.name, new Date().toISOString())
            .catch(() => undefined)
            .finally(() => void this.onFire(entry.name));
        });
        const prior = this.jobs.get(entry.name);
        if (prior) prior.stop();
        this.jobs.set(entry.name, job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `scheduler: skipping '${entry.name}' — invalid cron '${pattern}': ${message}`,
        );
      }
    }
  }

  /**
   * `Source.start` — no-op. The live producer is wired by `set()` (cron tick →
   * lastRun advance + onFire), called from the daemon's reconcile on boot and
   * SIGHUP; the cron tick fires directly through `onFire`. Nothing to bind
   * here; kept to satisfy the `Source` shape uniformly.
   */
  start(): void {}

  /**
   * `Source.recover` — anacron boot catch-up. For each active schedule, ask
   * croner whether the pattern would have fired strictly after `lastRun` and
   * at/before now; if so, `emit(name)` exactly once (N missed ticks collapse
   * to one) and advance `lastRun = now`. A fresh schedule (empty `lastRun`)
   * never catch-up-fires — it just seeds `lastRun = now`. Requires `set()` to
   * have run first (the daemon's reconcile does this before recover).
   */
  async recover(emit: Emit): Promise<void> {
    const now = new Date();
    for (const [name, job] of this.jobs) {
      const last = await readLastRun(name);
      if (!last) {
        await advanceLastRun(name, now.toISOString());
        continue;
      }
      const due = job.nextRun(new Date(last));
      if (!due || due > now) continue;
      await emit(name);
      await advanceLastRun(name, now.toISOString());
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
  }

  stats(): SchedulerStats {
    const entries = Array.from(this.jobs.entries()).map(([name, job]) => {
      const next = job.nextRun();
      return {
        name,
        pattern: job.getPattern() ?? "",
        nextRun: next ? next.toISOString() : null,
      };
    });
    return { count: entries.length, entries };
  }
}
