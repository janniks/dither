import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { configDir } from "./paths";
import { readGlobal, type LogEvent } from "./run-log";
import { statusAll, type LockTheme } from "./locks";
import { readMarkerState } from "./markers";

/**
 * Daemon-side qmd job journal surface.
 *
 * This module is qmd-free: it owns the `jobs/<id>.json` inflight files and
 * the `dither status` snapshot reduction, but never loads native qmd code
 * (openStore / embedLoop / acquireTheme). The actual reconcile runners live
 * in reconcile-run.ts, which only the `daemon reconcile` child imports — so
 * the daemon main thread's static import graph never reaches @tobilu/qmd.
 *
 * The daemon parses the child's NDJSON stream and is the sole writer of
 * `jobs/` + the global log via the journal sink (reconcile-sink.ts).
 */

export type JobType = "model-download" | "indexing" | "embedding";

export interface CurrentJob {
  jobId: string;
  type: JobType;
  startedAt: string;
  current?: number;
  total?: number;
}

export interface RecentJob {
  jobId: string;
  type: JobType;
  doneAt: string;
  durationMs?: number;
  /** For embedding: chunks embedded. */
  chunks?: number;
  /** For embedding: chunks truncated to fit 2048-token context. */
  truncated?: number;
  /** For indexing: files indexed (indexed + updated). */
  filesIndexed?: number;
  /** Set when the job ended unhappily. */
  failed?: string;
  /** Set when the job was skipped (lock contention etc). */
  skipped?: string;
}

export interface JobsSnapshot {
  current: CurrentJob[];
  recent: RecentJob[];
  needsReindex: boolean;
  embedDisabled: boolean;
}

// Persistent inflight-jobs directory. One file per active job; updated
// from emitProgress and unlinked at job end. Survives independently of
// the bounded log tail so long-running jobs don't disappear from status
// after their job-started event scrolls off.
function jobsDir(): string {
  return join(configDir(), "jobs");
}

function jobFilePath(jobId: string): string {
  return join(jobsDir(), `${jobId}.json`);
}

// Atomic write — tmp+rename so a concurrent `dither status` (via
// readCurrentJobsFromDisk) never observes a half-written job file.
// Matches the pattern openRun.close() uses for result.json.
async function writeJobFileAtomic(path: string, job: CurrentJob): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(job));
  await rename(tmp, path);
}

export async function markJobStarted(job: CurrentJob): Promise<void> {
  await mkdir(dirname(jobFilePath(job.jobId)), { recursive: true });
  await writeJobFileAtomic(jobFilePath(job.jobId), job);
}

export async function markJobProgress(jobId: string, current: number, total: number): Promise<void> {
  try {
    const raw = await readFile(jobFilePath(jobId), "utf-8");
    const cur = JSON.parse(raw) as CurrentJob;
    cur.current = current;
    cur.total = total;
    await writeJobFileAtomic(jobFilePath(jobId), cur);
  } catch (err) {
    // ENOENT: job ended between progress emits — fine.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function markJobEnded(jobId: string): Promise<void> {
  await unlink(jobFilePath(jobId)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

/** Wipe inflight-jobs files. Daemon calls this at startup so a previous
 *  crashed daemon's stale entries don't show up in `dither status`. */
export async function clearInflightJobs(): Promise<void> {
  await rm(jobsDir(), { recursive: true, force: true });
}

/**
 * Reconstruct current + recent job state for `dither status`. Current
 * jobs come from the persistent <home>/jobs/ directory (independent of
 * log retention). Recent terminal events come from the last 200 log
 * lines.
 */
export async function readJobsSnapshot(): Promise<JobsSnapshot> {
  const events = await readGlobal(200);
  return reduceJobsSnapshot(events, readCurrentJobsFromDisk());
}

function readCurrentJobsFromDisk(): CurrentJob[] {
  let entries: string[];
  try {
    entries = readdirSync(jobsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.flatMap((name) => {
    if (!name.endsWith(".json")) return [];
    try {
      const raw = readFileSync(join(jobsDir(), name), "utf-8");
      return [JSON.parse(raw) as CurrentJob];
    } catch {
      return [];
    }
  });
}

function reduceJobsSnapshot(events: LogEvent[], inflightOnDisk: CurrentJob[]): JobsSnapshot {
  const recent: RecentJob[] = [];
  for (const e of events) {
    const jobId = typeof e.jobId === "string" ? e.jobId : null;
    const type = typeof e.type === "string" ? (e.type as JobType) : null;
    if (!jobId || !type) continue;
    if (e.kind === "job-done") {
      recent.push({
        jobId,
        type,
        doneAt: e.ts,
        durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined,
        chunks: typeof e.chunks === "number" ? e.chunks : undefined,
        truncated: typeof e.truncated === "number" ? e.truncated : undefined,
        filesIndexed: typeof e.filesIndexed === "number" ? e.filesIndexed : undefined,
      });
    } else if (e.kind === "job-failed") {
      recent.push({
        jobId,
        type,
        doneAt: e.ts,
        failed: typeof e.error === "string" ? e.error : "unknown",
      });
    } else if (e.kind === "job-skipped") {
      recent.push({
        jobId,
        type,
        doneAt: e.ts,
        skipped: typeof e.reason === "string" ? e.reason : "unknown",
      });
    }
  }

  // Cross-check inflight-on-disk against live locks: an inflight file
  // whose lock isn't held anymore is stale (daemon crashed between
  // job-started and job-done) and shouldn't be reported as live.
  const locks = statusAll();
  const liveCurrent = inflightOnDisk.filter((job) => {
    const theme: LockTheme =
      job.type === "model-download" ? "download" : job.type === "indexing" ? "index" : "embed";
    return locks[theme];
  });

  return {
    current: liveCurrent,
    recent: recent.slice(-10),
    ...readMarkerState(),
  };
}

/** Reconcile cycle outcome, returned by the child runner (reconcile-run.ts). */
export interface ReconcileSummary {
  jobsRun: number;
  durationMs: number;
}
