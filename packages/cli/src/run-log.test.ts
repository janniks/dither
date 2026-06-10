import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

    it("truncateGlobal clears the size cache so a follow-up append doesn't spuriously rotate", async () => {
      const { ROTATION_THRESHOLD_BYTES, appendGlobal, truncateGlobal } =
        await import("./run-log");
      const { runLogPath } = await import("./home");
      await mkdir(home, { recursive: true });
      // Plant a near-threshold body so the size cache populates with a
      // rotation-near value on the first append.
      writeFileSync(runLogPath(), "x".repeat(ROTATION_THRESHOLD_BYTES - 50));
      await appendGlobal({ kind: "rotate" } as never);
      expect(existsSync(`${runLogPath()}.old`)).toBe(true);

      await truncateGlobal();
      // After truncate the .old file is gone AND the cache is cleared —
      // an append on the now-empty file must not see a stale cached size
      // and trigger a spurious rotation.
      await appendGlobal({ kind: "post-truncate" } as never);
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

    it("concurrent appends at the rotation threshold all survive", async () => {
      const { ROTATION_THRESHOLD_BYTES, appendGlobal } = await import("./run-log");
      const { runLogPath } = await import("./home");
      await mkdir(home, { recursive: true });
      const filler = "x".repeat(ROTATION_THRESHOLD_BYTES - 50);
      writeFileSync(runLogPath(), filler);

      // Fire 5 concurrent appends straddling the rotation point.
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          appendGlobal({ kind: `concurrent-${i}` } as never),
        ),
      );

      const main = readFileSync(runLogPath(), "utf-8").trim().split("\n").filter(Boolean);
      const old = existsSync(`${runLogPath()}.old`)
        ? readFileSync(`${runLogPath()}.old`, "utf-8").trim().split("\n").filter(Boolean)
        : [];
      // Of the 5 new events, no event was clobbered by the rotation race.
      const newKinds = [...main, ...old]
        .flatMap((l) => {
          try {
            return [(JSON.parse(l) as { kind: string }).kind];
          } catch {
            return [];
          }
        })
        .filter((k) => k.startsWith("concurrent-"))
        .sort();
      expect(newKinds).toEqual([
        "concurrent-0",
        "concurrent-1",
        "concurrent-2",
        "concurrent-3",
        "concurrent-4",
      ]);
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
      await handle.append({ kind: "added", path: "/x.md" });
      await handle.close({ status: "ok", finishedAt: new Date().toISOString(), added: ["/x.md"] });

      const events = await readRun(handle.runId);
      expect(events.map((e) => e.kind)).toEqual(["progress", "added"]);
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

    it("openRun honors a presupplied runId", async () => {
      const { openRun, generateRunId } = await import("./run-log");
      const id = generateRunId("myplugin");
      const handle = await openRun("myplugin", "manual", id);
      expect(handle.runId).toBe(id);
    });

    it("openRun throws when a presupplied runId collides with an existing run", async () => {
      const { openRun, generateRunId } = await import("./run-log");
      const id = generateRunId("myplugin");
      await openRun("myplugin", "manual", id);
      await expect(openRun("myplugin", "manual", id)).rejects.toThrow(/presupplied runId/);
    });

    it("openRun reuses an empty husk dir (no manifest) for a presupplied runId", async () => {
      const { openRun, generateRunId } = await import("./run-log");
      const id = generateRunId("myplugin");
      // Simulate an aborted prior openRun: dir exists, manifest never written.
      const husk = join(home, "history", id);
      await mkdir(husk, { recursive: true });
      expect(existsSync(join(husk, "manifest.json"))).toBe(false);

      const handle = await openRun("myplugin", "manual", id);
      expect(handle.runId).toBe(id);
      expect(handle.dir).toBe(husk);
      const manifest = JSON.parse(readFileSync(join(husk, "manifest.json"), "utf-8")) as { runId: string };
      expect(manifest.runId).toBe(id);
    });

    it("openRun retries on runId collision and produces distinct ids with intact manifests", async () => {
      // Force a single collision: first two randomBytes calls return the
      // same suffix; third call returns a different one. With the retry
      // loop in openRun, the second call should regenerate and succeed.
      vi.resetModules();
      vi.doMock("node:crypto", async () => {
        const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
        let n = 0;
        return {
          ...actual,
          default: actual,
          randomBytes: (size: number): Buffer => {
            n++;
            if (n <= 2) return Buffer.from([0xab, 0xcd, 0xef, 0x01]);
            return Buffer.from([0x12, 0x34, 0x56, 0x78]);
          },
        };
      });

      const { openRun, listRuns } = await import("./run-log");
      const h1 = await openRun("myplugin", "watch");
      const h2 = await openRun("myplugin", "watch");

      expect(h1.runId).not.toBe(h2.runId);
      expect(existsSync(join(h1.dir, "manifest.json"))).toBe(true);
      expect(existsSync(join(h2.dir, "manifest.json"))).toBe(true);

      const m1 = JSON.parse(readFileSync(join(h1.dir, "manifest.json"), "utf-8")) as { runId: string };
      const m2 = JSON.parse(readFileSync(join(h2.dir, "manifest.json"), "utf-8")) as { runId: string };
      expect(m1.runId).toBe(h1.runId);
      expect(m2.runId).toBe(h2.runId);

      const runs = await listRuns();
      expect(runs.map((r) => r.runId).toSorted()).toEqual([h1.runId, h2.runId].toSorted());

      vi.doUnmock("node:crypto");
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
