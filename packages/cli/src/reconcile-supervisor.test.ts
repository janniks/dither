import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileHandler } from "./reconcile-supervisor";
import { journalSink, stderrSink } from "./reconcile-sink";
import { readGlobal } from "./run-log";

/**
 * Phase-3 coverage for the daemon-side translation: the supervisor parses the
 * child's `_dither` NDJSON stderr and feeds it into a real `journalSink`,
 * making the daemon the sole writer of `jobs/` + the global run-log. A real
 * subprocess is infeasible here (no built bundle / tsx, and the `socket npx`
 * wrapper interferes), so we drive the line-handler directly: a `stderrSink`
 * produces the exact lines the child would emit, we replay them through
 * `reconcileHandler` (the supervisor's per-line logic) into a journalSink, and
 * assert the resulting jobs/ + global-log match what the inline journalSink
 * path produces for the same lifecycle. No mocks; real journal on both sides.
 */
describe("reconcile-supervisor handler", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-reconcile-sup-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  // Capture the NDJSON lines a child would emit for one index cycle.
  function childLines(): string[] {
    const lines: string[] = [];
    const sink = stderrSink((line) => lines.push(line));
    // Order mirrors qmdReconcile's index leg (reconcile-sink calls).
    void sink.jobStarted("indexing", "needs-reindex-marker");
    void sink.jobProgress("indexing", 0, 1);
    void sink.jobProgress("indexing", 1, 1);
    void sink.jobDone("indexing", { filesIndexed: 1, filesTotal: 1 });
    void sink.reconcileDone(1);
    return lines;
  }

  it("translates child NDJSON into the same journal the inline path writes", async () => {
    const cycleId = "cycle-1";
    const lines = childLines();

    // Daemon path: reconcileStarted bookend, replay child lines, reconcileDone.
    const handler = reconcileHandler();
    await handler.sink.reconcileStarted(cycleId);
    for (const line of lines) await handler.line(line);
    // reconcile-done line set jobsRun; daemon emits the bookend on close.
    expect(handler.jobsRun()).toBe(1);
    await handler.sink.reconcileDone(handler.jobsRun());

    const viaSupervisor = await readGlobal();
    // jobs/ fully drained — job-done unlinks the file.
    expect(readdirSync(join(home, "jobs")).filter((n) => n.endsWith(".json"))).toEqual([]);

    // Inline reference: same lifecycle straight through a journalSink in a
    // fresh home, asserting event-for-event equality (jobId + ts excluded —
    // they're random/clock).
    rmSync(home, { recursive: true, force: true });
    const ref = journalSink();
    await ref.reconcileStarted(cycleId);
    await ref.jobStarted("indexing", "needs-reindex-marker");
    await ref.jobProgress("indexing", 0, 1);
    await ref.jobProgress("indexing", 1, 1);
    await ref.jobDone("indexing", { filesIndexed: 1, filesTotal: 1 });
    await ref.reconcileDone(1);
    const inline = await readGlobal();

    expect(strip(viaSupervisor)).toEqual(strip(inline));
  });

  it("journals a non-_dither diagnostic line as {kind:'stderr'}", async () => {
    const handler = reconcileHandler();
    await handler.line("some native warning from qmd");
    const events = await readGlobal();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "stderr", line: "some native warning from qmd" });
  });

  it("emits reconcile-failed + reconcile-done(failed) for a nonzero child", async () => {
    // Mirror the close-path branch the supervisor runs on a nonzero exit.
    const handler = reconcileHandler();
    await handler.sink.reconcileStarted("cycle-2");
    await handler.sink.reconcileFailed("reconcile child exited 1");
    await handler.sink.reconcileDone(handler.jobsRun(), "failed");

    const events = await readGlobal();
    expect(events.map((e) => e.kind)).toEqual([
      "reconcile-started",
      "reconcile-failed",
      "reconcile-done",
    ]);
    expect(events[2]).toMatchObject({ kind: "reconcile-done", jobsRun: 0, reason: "failed" });
  });
});

// Drop random/clock-driven fields so two independent journal runs compare
// equal on the stable shape (kind + payload).
function strip(events: Array<Record<string, unknown>>) {
  return events.map((e) => {
    const { ts, jobId, ...rest } = e;
    void ts;
    void jobId;
    return rest;
  });
}
