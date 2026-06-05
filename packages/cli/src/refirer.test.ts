import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Refirer } from "./refirer";

describe("Refirer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires past the 32-bit ms ceiling instead of immediately", () => {
    vi.useFakeTimers();
    const fires: string[] = [];
    const refirer = new Refirer((name) => {
      fires.push(name);
    });

    const far = Date.now() + 0x7fffffff * 3 + 1234;
    refirer.set("p", far);

    vi.advanceTimersByTime(0x7fffffff);
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(0x7fffffff);
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(0x7fffffff);
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(1234);
    expect(fires).toEqual(["p"]);
  });

  it("skips invalid fireAt without throwing", () => {
    const fires: string[] = [];
    const refirer = new Refirer((name) => {
      fires.push(name);
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    refirer.set("p", Number.NaN);
    refirer.set("q", Number.POSITIVE_INFINITY);
    expect(refirer.stats().count).toBe(0);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("Refirer as Source", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-refirer-src-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  function writeRow(plugin: string, row: object) {
    mkdirSync(join(home, "refires"), { recursive: true });
    writeFileSync(join(home, "refires", `${plugin}.json`), JSON.stringify(row));
  }

  it("recover arms a timer per non-suspended persisted row; start is a no-op", async () => {
    vi.useFakeTimers();
    const fires: string[] = [];
    const refirer = new Refirer((name) => {
      fires.push(name);
    });
    // A due-now row and a suspended row that must NOT arm.
    writeRow("due", { fireAt: new Date(Date.now() + 1000).toISOString(), retryCount: 0, suspended: false });
    writeRow("dead", { fireAt: new Date(Date.now() + 1000).toISOString(), retryCount: 3, suspended: true });

    refirer.start(() => undefined);
    expect(refirer.stats().count).toBe(0); // start does not arm.

    await refirer.recover(() => undefined);
    expect(refirer.stats().count).toBe(1); // only the non-suspended row armed.

    vi.advanceTimersByTime(1000);
    expect(fires).toEqual(["due"]);
  });

  it("recover replaces prior timers (idempotent re-arm)", async () => {
    const refirer = new Refirer(() => undefined);
    writeRow("p", { fireAt: new Date(Date.now() + 3_600_000).toISOString(), retryCount: 0, suspended: false });
    await refirer.recover(() => undefined);
    await refirer.recover(() => undefined);
    expect(refirer.stats().count).toBe(1);
    refirer.stop();
  });
});
