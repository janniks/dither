import { Cron } from "croner";
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

export class Scheduler {
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
        const job = new Cron(pattern, () => {
          void this.onFire(entry.name);
        });
        this.jobs.set(entry.name, job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `scheduler: skipping '${entry.name}' — invalid cron '${pattern}': ${message}`,
        );
      }
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
