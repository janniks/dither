import { randomUUID } from "node:crypto";
import { appendGlobal } from "./run-log";
import type { JobType } from "./daemon-jobs";
import { markJobStarted, markJobProgress, markJobEnded } from "./daemon-jobs";
import type { JobDoneSummary } from "./reconcile-protocol";

/**
 * Reporting seam for the reconcile work. `qmdReconcile` calls these
 * lifecycle methods; *how* the events are reported (journal vs NDJSON) is
 * the sink's business. Two impls below:
 *
 *   - journalSink — what the daemon-inline path always did: mint jobIds,
 *     write `jobs/<id>.json`, append global-log events. Sole journal writer.
 *   - stderrSink — the child path: emit `_dither` NDJSON on stderr. The
 *     daemon parses + journals (Phase 3).
 */
export interface ReconcileSink {
  reconcileStarted(cycleId: string): Promise<void>;
  jobStarted(type: JobType, reason?: string): Promise<void>;
  jobProgress(type: JobType, cur: number, total: number): Promise<void>;
  jobDone(type: JobType, summary: JobDoneSummary): Promise<void>;
  jobFailed(type: JobType, error: string): Promise<void>;
  jobSkipped(type: JobType, reason: string): Promise<void>;
  reconcileFailed(error: string): Promise<void>;
  reconcileDone(jobsRun: number, reason?: string): Promise<void>;
}

/**
 * Daemon-inline sink. Byte-for-byte the journal behavior the old inline
 * runners had: one jobId per type for the cycle, `markJob*` writes to
 * `jobs/`, `appendGlobal` for every event. Owns the type→jobId map.
 */
export function journalSink(): ReconcileSink {
  const ids = new Map<JobType, string>();
  const idFor = (type: JobType): string => {
    const cur = ids.get(type);
    if (cur) return cur;
    const id = randomUUID();
    ids.set(type, id);
    return id;
  };
  let cycle = "";
  return {
    async reconcileStarted(cycleId) {
      cycle = cycleId;
      await appendGlobal({ kind: "reconcile-started", cycleId });
    },
    async jobStarted(type, reason) {
      const jobId = idFor(type);
      await markJobStarted({ jobId, type, startedAt: new Date().toISOString() });
      await appendGlobal({ kind: "job-started", jobId, type, ...(reason ? { reason } : {}) });
    },
    async jobProgress(type, cur, total) {
      const jobId = idFor(type);
      await markJobProgress(jobId, cur, total);
      await appendGlobal({ kind: "job-progress", jobId, type, current: cur, total });
    },
    async jobDone(type, summary) {
      const jobId = idFor(type);
      ids.delete(type);
      await markJobEnded(jobId);
      await appendGlobal({ kind: "job-done", jobId, type, ...summary });
    },
    async jobFailed(type, error) {
      const jobId = idFor(type);
      ids.delete(type);
      await appendGlobal({ kind: "job-failed", jobId, type, error });
      await markJobEnded(jobId);
    },
    async jobSkipped(type, reason) {
      await appendGlobal({ kind: "job-skipped", type, reason });
    },
    async reconcileFailed(error) {
      await appendGlobal({ kind: "reconcile-failed", cycleId: cycle, error });
    },
    async reconcileDone(jobsRun, reason) {
      await appendGlobal({
        kind: "reconcile-done",
        cycleId: cycle,
        jobsRun,
        ...(reason ? { reason } : {}),
      });
    },
  };
}

type Emit = (line: string) => void;

const stderrEmit: Emit = (line) => {
  process.stderr.write(line + "\n");
};

/**
 * Child-path sink. Emits `_dither` NDJSON on stderr; the daemon parses it
 * and owns the journal (Phase 3). `emit` is injectable so tests capture
 * lines without spawning a process.
 */
export function stderrSink(emit: Emit = stderrEmit): ReconcileSink {
  const send = (obj: Record<string, unknown>): void => emit(JSON.stringify(obj));
  return {
    // No-op on the child: the daemon emits the reconcile-started bookend at
    // spawn time (Phase 3), since it owns the cycleId and the journal. The
    // child has no cycleId and writes no journal, so there's nothing here.
    async reconcileStarted() {},
    async jobStarted(type, reason) {
      send({ _dither: "job-started", type, ...(reason ? { reason } : {}) });
    },
    async jobProgress(type, cur, total) {
      send({ _dither: "job-progress", type, cur, total });
    },
    async jobDone(type, summary) {
      send({ _dither: "job-done", type, ...summary });
    },
    // No NDJSON for failure: the child throws + exits non-zero, which the
    // daemon reads as the failure signal (Phase 3). No wire shape needed.
    async jobFailed() {},
    async jobSkipped(type, reason) {
      send({ _dither: "job-skipped", type, reason });
    },
    // No NDJSON: the child throws + exits non-zero on a cycle-level failure;
    // the daemon reads exit code (Phase 3), so no wire shape is needed.
    async reconcileFailed() {},
    async reconcileDone(jobsRun, reason) {
      send({ _dither: "reconcile-done", jobsRun, ...(reason ? { reason } : {}) });
    },
  };
}
