import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendGlobal } from "./run-log";
import { journalSink } from "./reconcile-sink";
import { parseReconcile } from "./reconcile-protocol";

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
 * `journalSink` / `appendGlobal`) + `parseReconcile`. qmd natives stay in the
 * child's address space.
 */

export interface ReconcileSupervisor {
  /** Resolves when the child has closed and the journal is fully written. */
  done: Promise<void>;
  /** The spawned child, so the daemon can SIGTERM it on shutdown (Phase 4). */
  child: ChildProcess;
}

/**
 * Translate the child's parsed NDJSON into journal writes. Factored out of the
 * spawn plumbing so tests feed lines directly into a real `journalSink` (no
 * subprocess) and assert the resulting `jobs/` + global-log match the inline
 * path. Returns the running `jobsRun` count carried by `reconcile-done`.
 */
export function reconcileHandler(sink = journalSink()) {
  let jobsRun = 0;
  const line = async (raw: string): Promise<void> => {
    const msg = parseReconcile(raw);
    if (!msg) {
      // Non-`_dither` diagnostic — journal verbatim (same as supervisor.ts).
      await appendGlobal({ kind: "stderr", line: raw });
      return;
    }
    if (msg.kind === "job-started") {
      await sink.jobStarted(msg.type, msg.reason);
      return;
    }
    if (msg.kind === "job-progress") {
      await sink.jobProgress(msg.type, msg.cur, msg.total);
      return;
    }
    if (msg.kind === "job-done") {
      const { kind, type, ...summary } = msg;
      await sink.jobDone(type, summary);
      return;
    }
    if (msg.kind === "job-skipped") {
      await sink.jobSkipped(msg.type, msg.reason);
      return;
    }
    // reconcile-done: remember the count; the daemon emits the bookend on close.
    jobsRun = msg.jobsRun;
  };
  return {
    sink,
    line,
    jobsRun: () => jobsRun,
  };
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
                  await handler.sink.reconcileFailed(`reconcile child exited ${code}`);
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
