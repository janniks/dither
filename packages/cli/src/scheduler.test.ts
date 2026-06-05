import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "./scheduler";
import { advanceLastRun, readLastRun } from "./schedule-state";

describe("Scheduler", () => {
  it("fires every-1s schedules at least twice within 2.5s", async () => {
    const fires: string[] = [];
    const sched = new Scheduler((name) => {
      fires.push(name);
    });

    sched.set([{ name: "ticker", schedule: "every 1s" }]);
    await new Promise((r) => setTimeout(r, 2500));
    sched.stop();

    expect(fires.length).toBeGreaterThanOrEqual(2);
    expect(fires.every((f) => f === "ticker")).toBe(true);
  }, 10_000);

  it("set() replaces the active set; old jobs stop firing", async () => {
    const fires: string[] = [];
    const sched = new Scheduler((name) => {
      fires.push(name);
    });

    sched.set([{ name: "first", schedule: "every 1s" }]);
    await new Promise((r) => setTimeout(r, 1200));
    expect(fires.some((f) => f === "first")).toBe(true);

    sched.set([{ name: "second", schedule: "every 1s" }]);
    fires.length = 0;
    await new Promise((r) => setTimeout(r, 1500));
    sched.stop();

    expect(fires.includes("second")).toBe(true);
    expect(fires.includes("first")).toBe(false);
  }, 10_000);

  it("malformed schedules don't take down sibling schedules", () => {
    const fires: string[] = [];
    const sched = new Scheduler((name) => {
      fires.push(name);
    });
    sched.set([
      { name: "good", schedule: "every 5m" },
      { name: "bad", schedule: "this is not a schedule" },
    ]);
    expect(sched.stats().count).toBe(1);
    expect(sched.stats().entries[0]?.name).toBe("good");
    sched.stop();
  });

  it("stop() makes stats empty", () => {
    const sched = new Scheduler(() => {});
    sched.set([{ name: "a", schedule: "every 5m" }]);
    expect(sched.stats().count).toBe(1);
    sched.stop();
    expect(sched.stats().count).toBe(0);
  });

  it("duplicate names within one set() do not leak the earlier Cron", async () => {
    const fires: string[] = [];
    const sched = new Scheduler((name) => {
      fires.push(name);
    });
    sched.set([
      { name: "dup", schedule: "every 1s" },
      { name: "dup", schedule: "every 5m" },
    ]);
    expect(sched.stats().count).toBe(1);
    expect(sched.stats().entries[0]?.pattern).not.toBe(
      // earlier "every 1s" must have been stopped, latest "every 5m" kept
      "* * * * * *",
    );
    await new Promise((r) => setTimeout(r, 1500));
    sched.stop();
    expect(fires).toEqual([]);
  }, 10_000);
});

describe("Scheduler durability (lastRun + anacron recover)", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-sched-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  const iso = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("recover fires once when a daily tick came due during downtime", async () => {
    await advanceLastRun("daily", iso(2 * 24 * 60 * 60 * 1000)); // 2 days ago
    const emits: string[] = [];
    const sched = new Scheduler(() => {});
    sched.set([{ name: "daily", schedule: "0 0 * * *" }]);
    await sched.recover((name) => void emits.push(name));
    sched.stop();
    expect(emits).toEqual(["daily"]);
    // lastRun advanced to ~now → no second catch-up
    const emits2: string[] = [];
    sched.set([{ name: "daily", schedule: "0 0 * * *" }]);
    await sched.recover((name) => void emits2.push(name));
    sched.stop();
    expect(emits2).toEqual([]);
  });

  it("recover does not fire when no tick was due", async () => {
    // lastRun 1 hour ago, pattern fires monthly on the 1st → not due
    await advanceLastRun("monthly", iso(60 * 60 * 1000));
    const emits: string[] = [];
    const sched = new Scheduler(() => {});
    sched.set([{ name: "monthly", schedule: "0 0 1 * *" }]);
    await sched.recover((name) => void emits.push(name));
    sched.stop();
    expect(emits).toEqual([]);
  });

  it("recover collapses N missed ticks into a single fire", async () => {
    // hourly pattern, lastRun 5 hours ago → 5 missed ticks, still one emit
    await advanceLastRun("hourly", iso(5 * 60 * 60 * 1000));
    const emits: string[] = [];
    const sched = new Scheduler(() => {});
    sched.set([{ name: "hourly", schedule: "0 * * * *" }]);
    await sched.recover((name) => void emits.push(name));
    sched.stop();
    expect(emits).toEqual(["hourly"]);
  });

  it("a fresh schedule (empty lastRun) does not catch-up-fire, just seeds lastRun", async () => {
    const emits: string[] = [];
    const sched = new Scheduler(() => {});
    sched.set([{ name: "fresh", schedule: "0 0 * * *" }]);
    expect(await readLastRun("fresh")).toBe("");
    await sched.recover((name) => void emits.push(name));
    sched.stop();
    expect(emits).toEqual([]);
    expect(await readLastRun("fresh")).not.toBe("");
  });

  it("a live fire advances lastRun", async () => {
    const sched = new Scheduler(() => {});
    sched.set([{ name: "ticker", schedule: "every 1s" }]);
    await new Promise((r) => setTimeout(r, 1500));
    sched.stop();
    expect(await readLastRun("ticker")).not.toBe("");
  }, 10_000);
});
