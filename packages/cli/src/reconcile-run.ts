import { randomUUID } from "node:crypto";
import { openStore } from "./store";
import { acquireTheme, releaseTheme, type LockHandle } from "./locks";
import { embedLoop } from "./progress";
import { claimReindex, readMarkerState, releaseReindexClaim } from "./markers";
import { journalSink, stderrSink, type ReconcileSink } from "./reconcile-sink";
import type { JobType, ReconcileSummary } from "./daemon-jobs";

/**
 * qmd reconcile child runner. Holds every native-qmd dependency
 * (`openStore` → @tobilu/qmd, `embedLoop`, `acquireTheme`) so the daemon
 * main thread never loads them: only the `daemon reconcile` child process
 * imports this module (`command-daemon.ts` dynamic-imports it).
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
 *
 * Reporting goes through a ReconcileSink (reconcile-sink.ts): the child
 * uses the stderr NDJSON sink and writes NO journal/`jobs/`; the daemon
 * parses the stream and owns the journal (Phase 3).
 */

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
  // Graceful stop on `dither daemon stop`: the daemon SIGTERMs us. A JS
  // handler can't interrupt a mid-batch native `store.embed()` (node-llama-cpp
  // blocks the event loop until the batch returns), so we set a flag that the
  // index/embed loop checks between iterations — same seam as the
  // embed-disabled marker. The in-flight batch finishes, then the loop exits
  // and `runJobWithLock`'s finally releases the theme lock, so a clean stop
  // never strands a `qmd-*.lock`. A hard kill is the backstop: the lock body
  // holds our PID, so the next acquirer reclaims it via `isPidAlive`.
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return qmdReconcile(stderrSink(emit), () => stopped);
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
export async function qmdReconcile(
  sink: ReconcileSink = journalSink(),
  shouldStop: () => boolean = () => false,
): Promise<ReconcileSummary> {
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
    // A SIGTERM between the index and embed legs skips embedding entirely —
    // the shutdown drain wants us to exit, not start a fresh multi-minute job.
    if (!shouldStop() && !readMarkerState().embedDisabled) {
      const status = await store.getStatus();
      if (status.needsEmbedding > 0) {
        const ran = await runEmbedJob(sink, store, shouldStop);
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
  shouldStop: () => boolean = () => false,
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
      // embed-disabled marker; a clean `daemon stop` SIGTERMs the child
      // (shouldStop). Between iterations the loop checks both and exits
      // early — current store.embed() batch still completes, but no
      // further iterations are queued, then runJobWithLock releases the lock.
      () => shouldStop() || readMarkerState().embedDisabled,
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
