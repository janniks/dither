import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("schedule-state", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-schedstate-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("readLastRun is empty before any advance", async () => {
    const { readLastRun } = await import("./schedule-state");
    expect(await readLastRun("p")).toBe("");
  });

  it("advanceLastRun records and reads back the time", async () => {
    const { advanceLastRun, readLastRun } = await import("./schedule-state");
    await advanceLastRun("p", "2026-05-13T00:00:01.000Z");
    expect(await readLastRun("p")).toBe("2026-05-13T00:00:01.000Z");
  });

  it("advanceLastRun is monotonic — an older time never lowers it", async () => {
    const { advanceLastRun, readLastRun } = await import("./schedule-state");
    await advanceLastRun("p", "2026-05-13T00:00:05.000Z");
    await advanceLastRun("p", "2026-05-13T00:00:01.000Z");
    expect(await readLastRun("p")).toBe("2026-05-13T00:00:05.000Z");
  });
});
