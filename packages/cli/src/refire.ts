import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveHome } from "./home";

/**
 * Per-plugin refire row. Persisted at `<home>/refires/<plugin>.json` so the
 * daemon picks it up across restarts.
 *
 * `fireAt`        — ISO timestamp; daemon's Refirer schedules a setTimeout to
 *                   fire at or shortly after this moment.
 * `retryCount`    — consecutive non-clean exits since the last clean run.
 *                   Used by the poison-pill guard: 3 in a row → `suspended`.
 * `suspended`     — daemon stops auto-refiring this plugin until a manual
 *                   run succeeds. inflight rows stay on disk for inspection.
 * `reason`        — optional human-readable note carried from the plugin's
 *                   `reschedule({ reason })`, or "poison-pill" / "failure".
 */
export interface RefireRow {
  fireAt: string;
  retryCount: number;
  suspended: boolean;
  reason?: string;
}

export const POISON_PILL_THRESHOLD = 3;

function refireDir(): string {
  return join(resolveHome(), "refires");
}

function refirePath(plugin: string): string {
  assertSafePluginName(plugin);
  return join(refireDir(), `${plugin}.json`);
}

function assertSafePluginName(plugin: string): void {
  if (!plugin || plugin.includes("/") || plugin.includes("\\") || plugin === "." || plugin === "..") {
    throw new Error(`invalid plugin name: ${JSON.stringify(plugin)}`);
  }
}

export async function readRefire(plugin: string): Promise<RefireRow | null> {
  try {
    const raw = await readFile(refirePath(plugin), "utf-8");
    return JSON.parse(raw) as RefireRow;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeRefire(plugin: string, row: RefireRow): Promise<void> {
  const p = refirePath(plugin);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(row, null, 2));
}

export async function clearRefire(plugin: string): Promise<void> {
  try {
    await unlink(refirePath(plugin));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function listRefires(): Promise<Array<{ plugin: string; row: RefireRow }>> {
  let entries: string[];
  try {
    entries = await readdir(refireDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Array<{ plugin: string; row: RefireRow }> = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const plugin = f.slice(0, -".json".length);
    const row = await readRefire(plugin);
    if (row) out.push({ plugin, row });
  }
  return out;
}

/**
 * Decide what to do at the end of a run, given the exit code and whether
 * the plugin asked for a reschedule. Pure function — no I/O — so the
 * branching is unit-testable.
 *
 *   reschedule-requested + exit 0 → schedule refire, keep inflight, reset counter
 *   exit 0 (no reschedule)        → clear refire row, clear inflight (caller)
 *   non-zero exit                 → increment retry; >= threshold → suspended
 */
export type RunDecision =
  | { kind: "ok-cleared" }
  | { kind: "ok-rescheduled"; row: RefireRow }
  | { kind: "failed-retry"; row: RefireRow }
  | { kind: "failed-suspended"; row: RefireRow };

export function decideRunOutcome(opts: {
  exitCode: number;
  rescheduleMs: number | null;
  rescheduleReason?: string;
  prior: RefireRow | null;
  now?: number;
}): RunDecision {
  const now = opts.now ?? Date.now();

  if (opts.exitCode === 0 && opts.rescheduleMs !== null) {
    const fireAt = new Date(now + Math.max(1000, opts.rescheduleMs)).toISOString();
    return {
      kind: "ok-rescheduled",
      row: {
        fireAt,
        retryCount: 0,
        suspended: false,
        ...(opts.rescheduleReason ? { reason: opts.rescheduleReason } : {}),
      },
    };
  }

  if (opts.exitCode === 0) {
    return { kind: "ok-cleared" };
  }

  const retryCount = (opts.prior?.retryCount ?? 0) + 1;
  if (retryCount >= POISON_PILL_THRESHOLD) {
    return {
      kind: "failed-suspended",
      row: {
        fireAt: new Date(now).toISOString(),
        retryCount,
        suspended: true,
        reason: `poison-pill: ${retryCount} consecutive non-clean exits`,
      },
    };
  }
  // Exponential backoff: 1m, 5m. (We only get 2 chances before suspension.)
  const backoffMs = retryCount === 1 ? 60_000 : 5 * 60_000;
  return {
    kind: "failed-retry",
    row: {
      fireAt: new Date(now + backoffMs).toISOString(),
      retryCount,
      suspended: false,
      reason: `failure: retry ${retryCount}`,
    },
  };
}
