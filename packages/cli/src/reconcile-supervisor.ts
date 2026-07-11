import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendGlobal } from "./run-log";
import { journalSink, type JobDoneSummary } from "./reconcile-sink";
import type { JobType } from "./daemon-jobs";

/**
 * Daemon-side supervisor for the `daemon reconcile` child (Phase 3).
 *
 * The daemon no longer executes qmd inline — it spawns the reconcile child
 * (mirroring the self-spawn in daemon-control.ts) and parses the child's
 * `_dither` NDJSON stderr, feeding each message into a `journalSink` so the
 * daemon stays the SOLE writer of `jobs/` + the global run-log. The child
 * emits intent; the daemon owns the journal.
 *
 * The `reconcile-started` / `reconcile-done` bookends are the daemon's: it
 * mints the cycleId and emits `reconcile-started` before the spawn, and
 * `reconcile-done` once the child closes — preserving the pair that watchers
 * (`dither status`, init's foreground watch) depend on.
 *
 * This module is qmd-free: it touches only the journal surface (via
 * `journalSink` / `appendGlobal`). qmd natives stay in the child's
 * address space.
 */

export interface ReconcileSupervisor {
  /** Resolves when the child has closed and the journal is fully written. */
  done: Promise<void>;
  /** The spawned child, so the daemon can SIGTERM it on shutdown (Phase 4). */
  child: ChildProcess;
}

const jobTypes = new Set<JobType>(["model-download", "indexing", "embedding"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

// job-done carries an open summary that varies by type: keep the numeric
// fields, drop the envelope tag + type.
function summaryOf(obj: Record<string, unknown>): JobDoneSummary {
  const out: Record<string, number> = {};
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "number") out[key] = obj[key];
  }
  return out as unknown as JobDoneSummary;
}

/**
 * Route the child's NDJSON lines onto a sink — the wire kind is the sink
 * method (kebab vs camel). Factored out of the spawn plumbing so tests feed
 * lines directly into a real `journalSink` (no subprocess) and assert the
 * resulting `jobs/` + global-log match the inline path. Non-`_dither` lines
 * journal as `{kind:"stderr"}`; malformed `_dither` envelopes are skipped.
 */
export function reconcileHandler(sink = journalSink()) {
  let jobsRun = 0;
  let failed = false;
  const line = async (raw: string): Promise<void> => {
    const obj = tryJson(raw);
    const kind = str(obj?._dither);
    if (!obj || !kind) {
      // Non-`_dither` diagnostic — journal verbatim (same as supervisor.ts).
      await appendGlobal({ kind: "stderr", line: raw });
      return;
    }
    if (kind === "reconcile-done") {
      // Remember the count; the daemon emits the bookend on close.
      jobsRun = num(obj.jobsRun);
      return;
    }
    if (kind === "reconcile-failed") {
      failed = true;
      await sink.reconcileFailed(String(obj.error ?? "unknown"));
      return;
    }
    const type = str(obj.type);
    if (!type || !jobTypes.has(type as JobType)) {
      // Malformed envelope — journal as a diagnostic rather than dropping it.
      await appendGlobal({ kind: "stderr", line: raw });
      return;
    }
    const t = type as JobType;
    if (kind === "job-started") await sink.jobStarted(t, str(obj.reason));
    if (kind === "job-progress") await sink.jobProgress(t, num(obj.cur), num(obj.total));
    if (kind === "job-done") await sink.jobDone(t, summaryOf(obj));
    if (kind === "job-failed") await sink.jobFailed(t, String(obj.error ?? "unknown"));
    if (kind === "job-skipped") await sink.jobSkipped(t, String(obj.reason ?? ""));
  };
  return {
    sink,
    line,
    jobsRun: () => jobsRun,
    failed: () => failed,
  };
}

function tryJson(raw: string): Record<string, unknown> | null {
  if (!raw || raw[0] !== "{") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Spawn `daemon reconcile` and supervise it. Emits the `reconcile-started`
 * bookend before spawn, line-buffers the child's stderr through
 * `reconcileHandler`, and emits `reconcile-done` (with `failed` reason on a
 * non-zero exit, matching the old inline `qmdReconcile`) once the child closes.
 */
export function superviseReconcile(spawn = nodeSpawn): ReconcileSupervisor {
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine CLI entrypoint to spawn reconcile child");

  const handler = reconcileHandler();
  const cycleId = randomUUID();

  const child = spawn(process.execPath, [entry, "daemon", "reconcile"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, DITHER_DAEMON: "1" },
  });

  const done = handler.sink
    .reconcileStarted(cycleId)
    .then(
      () =>
        new Promise<void>((res, rej) => {
          // Serialize per-line journal writes so jobs/ + global-log land in
          // emission order (the sink's idFor map isn't reentrancy-safe).
          let chain: Promise<void> = Promise.resolve();
          const handle = (raw: string): void => {
            chain = chain.then(() => handler.line(raw));
          };
          let buf = "";
          child.stderr!.setEncoding("utf-8");
          child.stderr!.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              handle(buf.slice(0, nl));
              buf = buf.slice(nl + 1);
            }
          });
          child.stderr!.on("end", () => {
            if (buf) handle(buf);
          });
          child.on("error", rej);
          child.on("close", (code) => {
            // Drain the queued line writes, then emit the daemon's bookend.
            // Match old qmdReconcile: a non-zero exit emits reconcile-failed
            // AND still emits reconcile-done (with reason "failed").
            void chain
              .then(async () => {
                if (code !== 0) {
                  // The wire usually carried the real error (reconcile-failed
                  // already journaled); exit-code inference is the fallback
                  // for a child that died without emitting one.
                  if (!handler.failed()) {
                    await handler.sink.reconcileFailed(`reconcile child exited ${code}`);
                  }
                  await handler.sink.reconcileDone(handler.jobsRun(), "failed");
                  return;
                }
                await handler.sink.reconcileDone(handler.jobsRun());
              })
              .then(res, rej);
          });
        }),
    );

  return { done, child };
}
