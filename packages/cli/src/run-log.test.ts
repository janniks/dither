import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("run-log", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-run-log-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe("global scope", () => {
    it("appends events with auto-ts and scope tag, reads them back", async () => {
      const { appendGlobal, readGlobal } = await import("./run-log");
      await appendGlobal({ kind: "daemon-started" });
      await appendGlobal({ kind: "job-started", jobId: "j1", type: "indexing" });

      const events = await readGlobal();
      expect(events).toHaveLength(2);
      expect(events[0]!.kind).toBe("daemon-started");
      expect(events[0]!.scope).toBe("global");
      expect(events[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(events[1]!.jobId).toBe("j1");
    });

    it("truncateGlobal removes both the main file and the .old rotation file", async () => {
      const { appendGlobal, truncateGlobal, readGlobal } = await import("./run-log");
      const { runLogPath } = await import("./home");
      await appendGlobal({ kind: "daemon-started" });
      // Plant a stale .old file.
      await mkdir(home, { recursive: true });
      writeFileSync(`${runLogPath()}.old`, '{"kind":"x","ts":"2026-01-01T00:00:00Z","scope":"global"}\n');
      expect(existsSync(`${runLogPath()}.old`)).toBe(true);

      await truncateGlobal();
      expect(await readGlobal()).toHaveLength(0);
      expect(existsSync(`${runLogPath()}.old`)).toBe(false);
    });

    it("rotates to .old when an append would exceed the 1 MB threshold", async () => {
      const { ROTATION_THRESHOLD_BYTES, appendGlobal } = await import("./run-log");
      const { runLogPath } = await import("./home");
      // Plant a near-threshold file directly so we don't burn 1 MB of appends.
      await mkdir(home, { recursive: true });
      // Fill to within 50 bytes of the threshold so the next event push
      // (an ~80 byte JSON line) crosses it and triggers rotation.
      const filler = "x".repeat(ROTATION_THRESHOLD_BYTES - 50);
      writeFileSync(runLogPath(), filler);

      await appendGlobal({ kind: "daemon-stopped" });
      // After rotation the main file holds only the new event.
      expect(existsSync(`${runLogPath()}.old`)).toBe(true);
      expect(statSync(runLogPath()).size).toBeLessThan(500);
    });

    it("followGlobal yields events as they're appended; aborts cleanly on signal", async () => {
      const { appendGlobal, followGlobal } = await import("./run-log");
      // Pre-create the file so followGlobal opens at byte-0 of an empty
      // file rather than skipping past the daemon-started write below.
      const { truncateGlobal } = await import("./run-log");
      await truncateGlobal();

      const ctrl = new AbortController();
      const seen: string[] = [];
      const pump = (async () => {
        for await (const e of followGlobal(ctrl.signal)) {
          seen.push(e.kind);
          if (seen.length >= 2) ctrl.abort();
        }
      })();

      await new Promise((r) => setTimeout(r, 150));
      await appendGlobal({ kind: "daemon-started" });
      await new Promise((r) => setTimeout(r, 150));
      await appendGlobal({ kind: "reconcile-done" });
      await pump;

      expect(seen).toEqual(["daemon-started", "reconcile-done"]);
    });

    it("tolerates ENOENT — followGlobal opens cleanly when the file does not yet exist", async () => {
      const { appendGlobal, followGlobal } = await import("./run-log");
      const ctrl = new AbortController();
      const seen: string[] = [];

      const pump = (async () => {
        for await (const e of followGlobal(ctrl.signal)) {
          seen.push(e.kind);
          ctrl.abort();
        }
      })();

      await new Promise((r) => setTimeout(r, 150));
      await appendGlobal({ kind: "daemon-started" });
      await pump;

      expect(seen).toContain("daemon-started");
    });
  });

  describe("run scope", () => {
    it("openRun writes manifest, appendRun streams to the run file, close writes result", async () => {
      const { openRun, readRun, listRuns } = await import("./run-log");
      const handle = await openRun("myplugin", "manual");
      await handle.append({ kind: "progress", message: "halfway" });
      await handle.append({ kind: "promoted", path: "/x.md" });
      await handle.close({ status: "ok", finishedAt: new Date().toISOString(), promoted: ["/x.md"] });

      const events = await readRun(handle.runId);
      expect(events.map((e) => e.kind)).toEqual(["progress", "promoted"]);
      expect(events[0]!.scope).toBe("run");
      expect(events[0]!.runId).toBe(handle.runId);

      const runs = await listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("ok");
      expect(runs[0]!.plugin).toBe("myplugin");
    });

    it("listRuns marks a Run with no result.json as 'running'", async () => {
      const { openRun, listRuns } = await import("./run-log");
      await openRun("myplugin", "watch");
      const runs = await listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("running");
    });

    it("followRun streams new events appended after the iterator starts", async () => {
      const { openRun, followRun } = await import("./run-log");
      const handle = await openRun("myplugin", "manual");

      const ctrl = new AbortController();
      const seen: string[] = [];
      const pump = (async () => {
        for await (const e of followRun(handle.runId, ctrl.signal)) {
          seen.push(e.kind);
          if (seen.length >= 1) ctrl.abort();
        }
      })();

      await new Promise((r) => setTimeout(r, 150));
      await handle.append({ kind: "progress", message: "tick" });
      await pump;

      expect(seen).toContain("progress");
    });
  });
});
