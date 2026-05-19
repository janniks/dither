import { describe, it, expect } from "vitest";
import { Scheduler } from "./scheduler";

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
