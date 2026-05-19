import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  embedDisabledPath,
  needsReindexPath,
  qmdReconcile,
} from "./daemon-jobs";
import { readEvents } from "./events-log";

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
      const events = await readEvents();
      // First event is reconcile-started; last is reconcile-done or
      // reconcile-failed (depending on how openStore handles it).
      expect(events[0]?.kind).toBe("reconcile-started");
      const last = events[events.length - 1]?.kind;
      expect(last === "reconcile-done" || last === "reconcile-failed").toBe(true);
    });

    it("each reconcile cycle has a unique cycleId", async () => {
      await qmdReconcile();
      await qmdReconcile();
      const events = await readEvents();
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
      const events = await readEvents();
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
});
