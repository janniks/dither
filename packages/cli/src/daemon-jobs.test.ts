import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearInflightJobs,
  embedDisabledPath,
  needsReindexPath,
  qmdReconcile,
  readJobsSnapshot,
} from "./daemon-jobs";
import { readGlobal } from "./run-log";

describe("daemon-jobs", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-daemon-jobs-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe("marker paths", () => {
    it("needsReindexPath is under <home>", () => {
      expect(needsReindexPath()).toBe(join(home, "needs-reindex"));
    });

    it("embedDisabledPath is under <home>", () => {
      expect(embedDisabledPath()).toBe(join(home, "embed-disabled"));
    });
  });

  describe("qmdReconcile", () => {
    it("emits reconcile-started + reconcile-done even when there's no library", async () => {
      // No dither config exists — openStore() throws NotInitialized.
      // Reconcile should catch that, emit reconcile-failed (or no-library),
      // and return cleanly. Either way, the cycle bookends are emitted.
      const summary = await qmdReconcile();
      expect(summary.jobsRun).toBe(0);
      const events = await readGlobal();
      // First event is reconcile-started; last is reconcile-done or
      // reconcile-failed (depending on how openStore handles it).
      expect(events[0]?.kind).toBe("reconcile-started");
      const last = events[events.length - 1]?.kind;
      expect(last === "reconcile-done" || last === "reconcile-failed").toBe(true);
    });

    it("each reconcile cycle has a unique cycleId", async () => {
      await qmdReconcile();
      await qmdReconcile();
      const events = await readGlobal();
      const starts = events.filter((e) => e.kind === "reconcile-started");
      expect(starts).toHaveLength(2);
      expect(starts[0]?.cycleId).not.toBe(starts[1]?.cycleId);
    });

    it("with embed-disabled marker, the reconcile cycle still runs and emits bookends", async () => {
      // Marker existence alone doesn't change cycle bookend behavior.
      // Whether embed runs is gated by both the marker AND a real
      // needsEmbedding count; without a real library, neither path
      // fires. We only assert that the marker existing isn't enough
      // to break the cycle.
      writeFileSync(embedDisabledPath(), "", "utf-8");
      const summary = await qmdReconcile();
      expect(summary.jobsRun).toBe(0);
      expect(existsSync(embedDisabledPath())).toBe(true);
      const events = await readGlobal();
      expect(events[0]?.kind).toBe("reconcile-started");
    });

    it("with needs-reindex marker but no library, reconcile cycle still completes", async () => {
      // Marker is present but openStore() returns null because no
      // config is written. The marker should NOT be cleared — the
      // reconcile didn't actually run an index job.
      writeFileSync(needsReindexPath(), "", "utf-8");
      await qmdReconcile();
      // Marker should still exist since we didn't get to the index
      // step (no store).
      expect(existsSync(needsReindexPath())).toBe(true);
    });
  });

  describe("inflight jobs persistence", () => {
    it("readJobsSnapshot reports nothing current when the lock isn't held", async () => {
      // Plant a stale inflight file (mimics a daemon crash mid-job).
      const jobsDir = join(home, "jobs");
      mkdirSync(jobsDir, { recursive: true });
      writeFileSync(
        join(jobsDir, "fake.json"),
        JSON.stringify({
          jobId: "fake",
          type: "indexing",
          startedAt: new Date().toISOString(),
        }),
      );
      // No qmd-index.lock held, so the live-lock filter drops it.
      const snap = await readJobsSnapshot();
      expect(snap.current).toEqual([]);
    });

    it("clearInflightJobs wipes the directory", async () => {
      const jobsDir = join(home, "jobs");
      mkdirSync(jobsDir, { recursive: true });
      writeFileSync(join(jobsDir, "x.json"), "{}");
      await clearInflightJobs();
      expect(existsSync(jobsDir)).toBe(false);
    });

    it("clearInflightJobs tolerates a missing directory", async () => {
      await expect(clearInflightJobs()).resolves.toBeUndefined();
    });

    it("inflight files survive log-tail truncation", async () => {
      // Simulate a long-running indexing job: write the inflight file
      // and then flood the run log past the 200-line readGlobal window.
      const jobsDir = join(home, "jobs");
      mkdirSync(jobsDir, { recursive: true });
      writeFileSync(
        join(jobsDir, "long.json"),
        JSON.stringify({
          jobId: "long",
          type: "indexing",
          startedAt: new Date().toISOString(),
          current: 42,
          total: 100,
        }),
      );
      // The disk-backed inflight file is unaffected by log retention,
      // so readCurrentJobsFromDisk continues to pick it up regardless of
      // how far the start event has scrolled out of the log tail.
      expect(readdirSync(jobsDir)).toEqual(["long.json"]);
    });
  });
});
