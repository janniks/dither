import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("journal", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-journal-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes manifest, appends events, finalizes with result", async () => {
    const { startRun, listRuns, readEvents } = await import("./journal");
    const { journal, runId } = await startRun("alpha", "manual");

    expect(existsSync(join(home, "history", runId, "manifest.json"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(home, "history", runId, "manifest.json"), "utf-8"),
    );
    expect(manifest.plugin).toBe("alpha");
    expect(manifest.trigger).toBe("manual");
    expect(manifest.runId).toBe(runId);

    await journal.append("progress", { message: "step 1", done: 1, total: 3 });
    await journal.append("stderr", { line: "hello" });
    await journal.append("promoted", { path: "/x/y.md" });

    await journal.close({
      status: "ok",
      finishedAt: new Date().toISOString(),
      promoted: ["/x/y.md"],
    });

    const events = await readEvents(runId);
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("progress");
    expect(events[1]?.type).toBe("stderr");
    expect(events[2]?.type).toBe("promoted");

    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.promotedCount).toBe(1);
    expect(runs[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves a failed run with stderr tail and exit code", async () => {
    const { startRun, listRuns } = await import("./journal");
    const { journal, runId } = await startRun("crasher", "manual");

    await journal.append("stderr", { line: "boom" });
    await journal.append("error", { message: "exit 1" });
    await journal.close({
      status: "fail",
      finishedAt: new Date().toISOString(),
      error: "exit 1",
      exitCode: 1,
      stderrTail: "boom",
    });

    const result = JSON.parse(readFileSync(join(home, "history", runId, "result.json"), "utf-8"));
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.stderrTail).toBe("boom");

    const runs = await listRuns();
    expect(runs[0]?.status).toBe("fail");
  });

  it("listRuns returns most-recent first", async () => {
    const { startRun, listRuns } = await import("./journal");

    const a = await startRun("first", "manual");
    await new Promise((r) => setTimeout(r, 1100)); // runId timestamp has 1s resolution
    const b = await startRun("second", "manual");

    await a.journal.close({ status: "ok", finishedAt: new Date().toISOString() });
    await b.journal.close({ status: "ok", finishedAt: new Date().toISOString() });

    const runs = await listRuns();
    expect(runs[0]?.plugin).toBe("second");
    expect(runs[1]?.plugin).toBe("first");
  });

  it("tailRun streams new events and stops on completion", async () => {
    const { startRun, tailRun } = await import("./journal");
    const { journal, runId } = await startRun("tailee", "manual");

    const seen: string[] = [];
    const handle = await tailRun(
      runId,
      (e) => seen.push(e.type),
      () => seen.push("_done"),
    );

    await journal.append("stderr", { line: "one" });
    await new Promise((r) => setTimeout(r, 200));
    await journal.append("stderr", { line: "two" });
    await new Promise((r) => setTimeout(r, 200));
    await journal.close({ status: "ok", finishedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 250));

    await handle.stop();

    expect(seen.filter((s) => s === "stderr")).toHaveLength(2);
    expect(seen).toContain("_done");
  }, 10_000);

  it("listRuns returns empty when history dir is absent", async () => {
    const { listRuns } = await import("./journal");
    const runs = await listRuns();
    expect(runs).toEqual([]);
  });
});
