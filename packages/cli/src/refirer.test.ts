import { describe, it, expect, vi, afterEach } from "vitest";
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
