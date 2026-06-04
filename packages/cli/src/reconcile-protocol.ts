import type { JobType } from "./daemon-jobs";

/**
 * Child → daemon NDJSON protocol for `dither daemon reconcile`.
 *
 * The reconcile child streams one JSON object per stderr line, reusing the
 * `_dither` envelope convention from supervisor.ts (`parseControl`). The
 * daemon parses these and is the sole writer of `jobs/` + the global
 * run-log — the child emits *intent*, the daemon translates it to journal
 * state. jobIds are NOT carried on the wire: only one job per `type` runs
 * per reconcile cycle, so the daemon mints + keys jobIds by `type` (Phase 3).
 *
 * Message kinds (one per line):
 *   {_dither:"job-started",  type, reason?}
 *   {_dither:"job-progress", type, cur, total}
 *   {_dither:"job-done",     type, ...summary}
 *       embedding:        chunks, truncated, iterations, durationMs
 *       indexing:         filesIndexed, filesTotal
 *       model-download:   durationMs
 *   {_dither:"job-skipped",  type, reason}        // lock-busy lands in Phase 4
 *   {_dither:"reconcile-done", jobsRun, reason?}
 *
 * Non-`_dither` stderr lines are real diagnostics; the daemon journals them
 * as {kind:"stderr"} (same as supervisor.ts).
 */

export interface EmbedDoneSummary {
  chunks: number;
  truncated: number;
  iterations: number;
  durationMs: number;
}

export interface IndexDoneSummary {
  filesIndexed: number;
  filesTotal: number;
}

export interface DownloadDoneSummary {
  durationMs: number;
}

export type JobDoneSummary = EmbedDoneSummary | IndexDoneSummary | DownloadDoneSummary;

export type ReconcileMessage =
  | { kind: "job-started"; type: JobType; reason?: string }
  | { kind: "job-progress"; type: JobType; cur: number; total: number }
  | ({ kind: "job-done"; type: JobType } & JobDoneSummary)
  | { kind: "job-skipped"; type: JobType; reason: string }
  | { kind: "reconcile-done"; jobsRun: number; reason?: string };

const types = new Set<JobType>(["model-download", "indexing", "embedding"]);

function asType(v: unknown): JobType | null {
  return typeof v === "string" && types.has(v as JobType) ? (v as JobType) : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Parse one stderr line into a ReconcileMessage. Returns null for
 * non-`_dither` lines (diagnostics) and malformed envelopes. Phase 3's
 * daemon-side supervisor reuses this verbatim.
 */
export function parseReconcile(line: string): ReconcileMessage | null {
  if (!line || line[0] !== "{") return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const tag = obj._dither;
    if (tag === "reconcile-done") {
      const jobsRun = num(obj.jobsRun);
      if (jobsRun === undefined) return null;
      return {
        kind: "reconcile-done",
        jobsRun,
        ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
      };
    }
    const type = asType(obj.type);
    if (!type) return null;
    if (tag === "job-started") {
      return {
        kind: "job-started",
        type,
        ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
      };
    }
    if (tag === "job-progress") {
      const cur = num(obj.cur);
      const total = num(obj.total);
      if (cur === undefined || total === undefined) return null;
      return { kind: "job-progress", type, cur, total };
    }
    if (tag === "job-done") {
      return { kind: "job-done", type, ...stripEnvelope(obj) };
    }
    if (tag === "job-skipped") {
      if (typeof obj.reason !== "string") return null;
      return { kind: "job-skipped", type, reason: obj.reason };
    }
    return null;
  } catch {
    return null;
  }
}

// job-done carries an open summary shape that varies by type. Keep the
// numeric summary fields, drop the envelope tag + type so the parsed
// message mirrors what was emitted.
function stripEnvelope(obj: Record<string, unknown>): JobDoneSummary {
  const out: Record<string, number> = {};
  for (const key of Object.keys(obj)) {
    if (key === "_dither" || key === "type") continue;
    const v = num(obj[key]);
    if (v !== undefined) out[key] = v;
  }
  return out as unknown as JobDoneSummary;
}
