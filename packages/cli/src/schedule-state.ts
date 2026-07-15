import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { scheduleStatePath } from "./paths";

/**
 * Per-plugin `lastRun` — the scheduler's durability layer for the down-window
 * gap. Croner is in-memory, so a tick due while the daemon is down is silently
 * dropped. We persist the last time each schedule actually fired:
 *
 *   <config>/schedule-state/<plugin>.json = { lastRun: "<ISO>" }
 *
 * Boot `recover` reads it, asks croner whether the pattern would have fired
 * between `lastRun` and now, and (if so) fires once — anacron-style catch-up.
 * Mirrors `watch-state.ts`: ENOENT → "", atomic tmp+rename write, monotonic.
 */

interface ScheduleState {
  lastRun: string;
}

/** Read the last fire time, or `""` when none has been recorded yet. */
export async function readLastRun(plugin: string): Promise<string> {
  try {
    const raw = await readFile(scheduleStatePath(plugin), "utf-8");
    return (JSON.parse(raw) as ScheduleState).lastRun ?? "";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Advance `lastRun` to `when` when it's newer than what's stored. Monotonic —
 * an out-of-order (older) write never moves it backwards.
 */
export async function advanceLastRun(plugin: string, when: string): Promise<void> {
  if (when <= (await readLastRun(plugin))) return;
  const file = scheduleStatePath(plugin);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ lastRun: when } satisfies ScheduleState));
  await rename(tmp, file);
}
