import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { resolveHome } from "./home";
import { openStore } from "./store";
import { readGlobal, type LogEvent } from "./run-log";
import { acquireTheme, releaseTheme, statusAll, type LockHandle, type LockTheme } from "./locks";
import { embedLoop } from "./progress";
import { claimReindex, readMarkerState, releaseReindexClaim } from "./markers";
import { journalSink, stderrSink, type ReconcileSink } from "./reconcile-sink";

/**
 * Daemon-side qmd state reconciler + job runners.
 *
 * On each trigger (daemon startup, SIGHUP, post-job, init-handoff), the
 * reconciler discovers what work the qmd state implies and runs jobs
 * sequentially. The model is stateless w.r.t. work intent — the SQLite
 * state + marker files (see markers.ts) are the source of truth, so a
 * fresh init, a crash recovery, and a user-triggered reindex all flow
 * through the same code path.
 *
 * Lock topology (see locks.ts): one lock per job theme. Jobs acquire
 * their theme lock at start, release at end. Failed acquisitions (lock
 * already held by another process) emit a `job-skipped` event and the
 * reconciler continues to the next phase.
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
  return join(resolveHome(), "jobs");
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

export interface ReconcileSummary {
  jobsRun: number;
  durationMs: number;
}

/**
 * Child-process entrypoint for `dither daemon reconcile`. Runs the full
 * qmd reconcile (openStore → index → embed) in its own process so the
 * daemon's event loop never blocks on native qmd code. Reports via the
 * stderr NDJSON sink — it writes NO journal/`jobs/`; the daemon parses the
 * stream and owns the journal (Phase 3). `emit` is injectable so tests
 * capture lines without spawning.
 *
 * Sets process.title so the worker is legible in `ps` separate from the
 * daemon main loop.
 */
export async function runReconcileChild(
  emit?: (line: string) => void,
): Promise<ReconcileSummary> {
  process.title = "dither daemon reconcile";
  return qmdReconcile(stderrSink(emit));
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
export async function qmdReconcile(sink: ReconcileSink = journalSink()): Promise<ReconcileSummary> {
  const startedAt = Date.now();
  const cycleId = randomUUID();
  await sink.reconcileStarted(cycleId);

  let jobsRun = 0;
  let store: Awaited<ReturnType<typeof openStore>> = null;
  let failed: string | null = null;
  try {
    store = await openStore();
    if (!store) {
      await sink.reconcileDone(jobsRun, "no-library");
      return { jobsRun, durationMs: Date.now() - startedAt };
    }

    // Step 1: explicit reindex request via marker, OR an empty/new
    // index that benefits from a first-pass scan. claimReindex does
    // the atomic rename so any request arriving during the cycle lands
    // on a fresh marker and is picked up next cycle.
    if (claimReindex()) {
      const ran = await runIndexJob(sink, store, "needs-reindex-marker");
      if (ran) jobsRun++;
      releaseReindexClaim();
    } else {
      // First-ever reconcile on a fresh library: index everything.
      const status = await store.getStatus();
      if (status.totalDocuments === 0 && status.collections.length > 0) {
        const ran = await runIndexJob(sink, store, "first-pass");
        if (ran) jobsRun++;
      }
    }

    // Step 2: chunks need embedding, AND user hasn't cancelled embed.
    if (!readMarkerState().embedDisabled) {
      const status = await store.getStatus();
      if (status.needsEmbedding > 0) {
        const ran = await runEmbedJob(sink, store);
        if (ran) jobsRun++;
      }
    }
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
  } finally {
    if (store) await store.close().catch(() => undefined);
  }

  if (failed) await sink.reconcileFailed(failed);
  await sink.reconcileDone(jobsRun);
  return { jobsRun, durationMs: Date.now() - startedAt };
}

/**
 * Run an indexing job. Acquires `qmd-index.lock`; if busy, emits a
 * `job-skipped` event and returns false (caller continues to the next
 * phase). On success, emits `job-started` / `job-progress` (per qmd
 * onProgress tick) / `job-done`.
 */
async function runIndexJob(
  sink: ReconcileSink,
  store: NonNullable<Awaited<ReturnType<typeof openStore>>>,
  reason: string,
): Promise<boolean> {
  const handle = await acquireTheme("index");
  if (handle === null) {
    await sink.jobSkipped("indexing", "lock-busy");
    return false;
  }
  return runJobWithLock(sink, handle, "indexing", async (emit) => {
    await sink.jobStarted("indexing", reason);
    const result = await store.update({
      onProgress: ({ current, total }) => {
        emit(current, total);
      },
    });
    await sink.jobDone("indexing", {
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
  sink: ReconcileSink,
  store: NonNullable<Awaited<ReturnType<typeof openStore>>>,
): Promise<boolean> {
  const handle = await acquireTheme("embed");
  if (handle === null) {
    await sink.jobSkipped("embedding", "lock-busy");
    return false;
  }
  return runJobWithLock(sink, handle, "embedding", async (emit) => {
    // Optimistic: emit a model-download job-started; if the first
    // embed-onProgress arrives quickly the model was already cached
    // and we close the download event immediately. Otherwise the
    // download is genuinely in progress.
    await sink.jobStarted("model-download");
    const downloadStartedAt = Date.now();
    let downloadClosed = false;
    const closeDownload = async (): Promise<void> => {
      if (downloadClosed) return;
      downloadClosed = true;
      await sink.jobDone("model-download", { durationMs: Date.now() - downloadStartedAt });
    };

    await sink.jobStarted("embedding");
    const summary = await embedLoop(
      store,
      (embedded, total) => {
        void closeDownload();
        emit(embedded, total);
      },
      // Cancellation hand-off: `dither index cancel` writes the
      // embed-disabled marker. Between iterations the loop checks it
      // and exits early — current store.embed() batch still completes,
      // but no further iterations are queued.
      () => readMarkerState().embedDisabled,
    );
    // Edge: nothing to embed → onProgress never fired → close download anyway.
    await closeDownload();

    await sink.jobDone("embedding", {
      chunks: summary.chunks,
      truncated: summary.truncated,
      iterations: summary.iterations,
      durationMs: summary.durationMs,
    });
  });
}

/**
 * Shared lock+events scaffolding for the two job runners. Ensures the lock
 * is released on any exit (success, failure, abort) and exposes a debounced
 * progress callback routed through the sink. Job identity (jobId minting,
 * journal vs NDJSON) is the sink's concern — this only debounces + reports.
 */
async function runJobWithLock(
  sink: ReconcileSink,
  handle: LockHandle,
  type: JobType,
  fn: (emit: (cur: number, total: number) => void) => Promise<void>,
): Promise<boolean> {
  let lastAt = 0;
  const PROGRESS_DEBOUNCE_MS = 100;
  const emit = (cur: number, total: number): void => {
    const now = Date.now();
    if (now - lastAt < PROGRESS_DEBOUNCE_MS && cur < total) return;
    lastAt = now;
    void sink.jobProgress(type, cur, total);
  };
  try {
    await fn(emit);
    return true;
  } catch (err) {
    await sink.jobFailed(type, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await releaseTheme(handle);
  }
}
