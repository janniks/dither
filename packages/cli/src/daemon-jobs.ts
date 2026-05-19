import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveHome } from "./home";
import { openStore } from "./store";
import { appendEvent } from "./events-log";
import {
  tryAcquireQmdLock,
  releaseQmdLock,
  type QmdLockHandle,
} from "./qmd-locks";
import { embedLoop } from "./progress";
import { readEvents, type BaseEvent } from "./events-log";
import { qmdLockStatus } from "./qmd-locks";

/**
 * Daemon-side qmd state reconciler + job runners.
 *
 * On each trigger (daemon startup, SIGHUP, post-job, init-handoff), the
 * reconciler discovers what work the qmd state implies and runs jobs
 * sequentially. The model is stateless w.r.t. work intent — the SQLite
 * state + marker files are the source of truth, so a fresh init, a
 * crash recovery, and a user-triggered reindex all flow through the
 * same code path.
 *
 * Marker files under `~/.dither/`:
 *   - `needs-reindex`: any non-daemon writer touches this when it
 *     couldn't acquire qmd-index.lock; the daemon coalesces all
 *     deferred reindex requests into one follow-up pass.
 *   - `embed-disabled`: written by `dither index cancel`; the
 *     reconciler skips embedding while this exists. Cleared by
 *     `dither index update`.
 *
 * Lock topology (see qmd-locks.ts): one lock per job theme. Jobs
 * acquire their theme lock at start, release at end. Failed
 * acquisitions (lock already held by another process) emit a
 * `job-skipped` event and the reconciler continues to the next phase.
 */

/** Path of the `needs-reindex` marker file. */
export function needsReindexPath(): string {
  return join(resolveHome(), "needs-reindex");
}

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

/**
 * Read the events log to reconstruct current + recent job state. Used
 * by `dither status` so the user has one command to ask "what is the
 * daemon doing right now, and what did it just finish?" `current` is
 * derived from the latest `job-started` events without a matching
 * `job-done` / `job-failed` / `job-skipped` AND a live lock holder.
 * `recent` is the last few terminal events.
 *
 * Read-only — never writes to the log. Cheap; reads at most the last
 * 200 lines.
 */
export async function readJobsSnapshot(): Promise<JobsSnapshot> {
  const events = await readEvents(200);
  return reduceJobsSnapshot(events);
}

function reduceJobsSnapshot(events: BaseEvent[]): JobsSnapshot {
  const inflight = new Map<string, CurrentJob>();
  const recent: RecentJob[] = [];
  for (const e of events) {
    const jobId = typeof e.jobId === "string" ? e.jobId : null;
    const type = typeof e.type === "string" ? (e.type as JobType) : null;
    if (!jobId || !type) continue;
    if (e.kind === "job-started") {
      inflight.set(jobId, { jobId, type, startedAt: e.ts });
    } else if (e.kind === "job-progress") {
      const cur = inflight.get(jobId);
      if (cur) {
        cur.current = typeof e.current === "number" ? e.current : undefined;
        cur.total = typeof e.total === "number" ? e.total : undefined;
      }
    } else if (e.kind === "job-done") {
      inflight.delete(jobId);
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
      inflight.delete(jobId);
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

  // Cross-check inflight against lock state: a "current" job whose lock
  // isn't held anymore is stale (daemon crashed between job-started and
  // job-done) and shouldn't be reported as live.
  const locks = qmdLockStatus();
  const liveCurrent: CurrentJob[] = [];
  for (const job of inflight.values()) {
    const theme =
      job.type === "model-download" ? "download" : job.type === "indexing" ? "index" : "embed";
    if (locks[theme]) liveCurrent.push(job);
  }

  // Keep the last few terminal events in chronological order; cap at 10.
  const recentTail = recent.slice(-10);

  return {
    current: liveCurrent,
    recent: recentTail,
    needsReindex: existsSync(needsReindexPath()),
    embedDisabled: existsSync(embedDisabledPath()),
  };
}

/** Path of the `embed-disabled` marker file. */
export function embedDisabledPath(): string {
  return join(resolveHome(), "embed-disabled");
}

export interface ReconcileSummary {
  jobsRun: number;
  durationMs: number;
}

/**
 * Top-level reconciler. Emits a `reconcile-started` event, runs all
 * jobs implied by the current state, emits `reconcile-done`. Returns a
 * summary of what ran. Always safe to call concurrently with other
 * reconciles — the per-theme locks serialize the actual work.
 *
 * Watchers (init's foreground watch, `dither status`) use the
 * `reconcile-started` / `reconcile-done` pair as session bookends.
 */
export async function qmdReconcile(): Promise<ReconcileSummary> {
  const startedAt = Date.now();
  const cycleId = randomUUID();
  await appendEvent({ kind: "reconcile-started", cycleId });

  let jobsRun = 0;
  let store: Awaited<ReturnType<typeof openStore>> = null;
  try {
    store = await openStore();
    if (!store) {
      await appendEvent({ kind: "reconcile-done", cycleId, jobsRun, reason: "no-library" });
      return { jobsRun, durationMs: Date.now() - startedAt };
    }

    // Step 1: explicit reindex request via marker, OR an empty/new
    // index that benefits from a first-pass scan.
    if (existsSync(needsReindexPath())) {
      const ran = await runIndexJob(store, "needs-reindex-marker");
      if (ran) {
        jobsRun++;
        try {
          unlinkSync(needsReindexPath());
        } catch {
          // Already gone — fine.
        }
      }
    } else {
      // First-ever reconcile on a fresh library: index everything.
      const status = await store.getStatus();
      if (status.totalDocuments === 0 && status.collections.length > 0) {
        const ran = await runIndexJob(store, "first-pass");
        if (ran) jobsRun++;
      }
    }

    // Step 2: chunks need embedding, AND user hasn't cancelled embed.
    if (!existsSync(embedDisabledPath())) {
      const status = await store.getStatus();
      if (status.needsEmbedding > 0) {
        const ran = await runEmbedJob(store);
        if (ran) jobsRun++;
      }
    }
  } catch (err) {
    await appendEvent({
      kind: "reconcile-failed",
      cycleId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (store) await store.close().catch(() => undefined);
  }

  await appendEvent({ kind: "reconcile-done", cycleId, jobsRun });
  return { jobsRun, durationMs: Date.now() - startedAt };
}

/**
 * Run an indexing job. Acquires `qmd-index.lock`; if busy, emits a
 * `job-skipped` event and returns false (caller continues to the next
 * phase). On success, emits `job-started` / `job-progress` (per qmd
 * onProgress tick) / `job-done`.
 */
async function runIndexJob(
  store: NonNullable<Awaited<ReturnType<typeof openStore>>>,
  reason: string,
): Promise<boolean> {
  const lockResult = await tryAcquireQmdLock("index");
  if (lockResult.busy) {
    await appendEvent({
      kind: "job-skipped",
      type: "indexing",
      reason: "lock-busy",
    });
    return false;
  }
  return runJobWithLock(lockResult, async (jobId, emitProgress) => {
    await appendEvent({ kind: "job-started", jobId, type: "indexing", reason });
    const result = await store.update({
      onProgress: ({ current, total }) => {
        emitProgress({ current, total });
      },
    });
    await appendEvent({
      kind: "job-done",
      jobId,
      type: "indexing",
      filesIndexed: result.indexed + result.updated,
      filesTotal: result.indexed + result.updated + result.unchanged,
    });
  });
}

/**
 * Run an embedding job. Acquires `qmd-embed.lock`; if busy, emits a
 * `job-skipped` event. Uses `embedLoop` so the 10-minute qmd
 * `LLMSession` ceiling doesn't silently abandon chunks.
 *
 * Model download (qmd's lazy first-use fetch) happens inside the first
 * `store.embed()` call. We bracket that with explicit `job-started` /
 * `job-done` events of type `model-download` so watchers can render
 * the download phase distinctly.
 */
async function runEmbedJob(
  store: NonNullable<Awaited<ReturnType<typeof openStore>>>,
): Promise<boolean> {
  const lockResult = await tryAcquireQmdLock("embed");
  if (lockResult.busy) {
    await appendEvent({ kind: "job-skipped", type: "embedding", reason: "lock-busy" });
    return false;
  }
  return runJobWithLock(lockResult, async (jobId, emitProgress) => {
    let downloadJobId: string | null = null;
    // Optimistic: emit a model-download job-started; if the first
    // embed-onProgress arrives quickly the model was already cached
    // and we close the download event immediately. Otherwise the
    // download is genuinely in progress.
    downloadJobId = randomUUID();
    await appendEvent({ kind: "job-started", jobId: downloadJobId, type: "model-download" });
    const downloadStartedAt = Date.now();
    let downloadClosed = false;
    const closeDownload = async (): Promise<void> => {
      if (downloadClosed || !downloadJobId) return;
      downloadClosed = true;
      await appendEvent({
        kind: "job-done",
        jobId: downloadJobId,
        type: "model-download",
        durationMs: Date.now() - downloadStartedAt,
      });
    };

    await appendEvent({ kind: "job-started", jobId, type: "embedding" });
    const summary = await embedLoop(store, (cumEmbedded, totalEstimate) => {
      void closeDownload();
      emitProgress({ current: cumEmbedded, total: totalEstimate });
    });
    // Edge: nothing to embed → onProgress never fired → close download anyway.
    await closeDownload();

    await appendEvent({
      kind: "job-done",
      jobId,
      type: "embedding",
      chunks: summary.chunks,
      truncated: summary.truncated,
      iterations: summary.iterations,
      durationMs: summary.durationMs,
    });
  });
}

/**
 * Shared lock+events scaffolding for the two job runners. Generates a
 * jobId, ensures the lock is released on any exit (success, failure,
 * abort), and exposes a debounced `emitProgress` callback.
 */
async function runJobWithLock(
  lockResult: QmdLockHandle,
  fn: (
    jobId: string,
    emitProgress: (info: { current: number; total: number }) => void,
  ) => Promise<void>,
): Promise<boolean> {
  const jobId = randomUUID();
  let lastEmitAt = 0;
  const PROGRESS_DEBOUNCE_MS = 100;
  const emitProgress = (info: { current: number; total: number }): void => {
    const now = Date.now();
    if (now - lastEmitAt < PROGRESS_DEBOUNCE_MS && info.current < info.total) {
      return;
    }
    lastEmitAt = now;
    void appendEvent({
      kind: "job-progress",
      jobId,
      type: lockResult.theme === "index" ? "indexing" : "embedding",
      current: info.current,
      total: info.total,
    });
  };
  try {
    await fn(jobId, emitProgress);
    return true;
  } catch (err) {
    await appendEvent({
      kind: "job-failed",
      jobId,
      type: lockResult.theme === "index" ? "indexing" : "embedding",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await releaseQmdLock(lockResult);
  }
}
