import { describe, it, expect } from "vitest";
import { LoopDetector } from "./loop-detector";

describe("LoopDetector", () => {
  it("halts at depth 4 with default threshold 3", () => {
    const d = new LoopDetector();
    expect(d.shouldHalt("schedule:tagger", "tagger")).toBe(false);
    d.record("schedule:tagger", "tagger", true);
    expect(d.shouldHalt("schedule:tagger", "tagger")).toBe(false);
    d.record("schedule:tagger", "tagger", true);
    expect(d.shouldHalt("schedule:tagger", "tagger")).toBe(false);
    d.record("schedule:tagger", "tagger", true);
    // Depth is now 3; next fire would be depth 4 → halt.
    expect(d.shouldHalt("schedule:tagger", "tagger")).toBe(true);
    d.record("schedule:tagger", "tagger", false);
    expect(d.recentHalts).toHaveLength(1);
    expect(d.recentHalts[0]?.depth).toBe(4);
  });

  it("respects custom threshold", () => {
    const d = new LoopDetector({ threshold: 1 });
    expect(d.shouldHalt("a", "x")).toBe(false);
    d.record("a", "x", true);
    expect(d.shouldHalt("a", "x")).toBe(true);
  });

  it("ages out chains after the TTL", async () => {
    const d = new LoopDetector({ ttlMs: 50 });
    d.record("a", "x", true);
    d.record("a", "x", true);
    d.record("a", "x", true);
    expect(d.shouldHalt("a", "x")).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(d.shouldHalt("a", "x")).toBe(false);
  });

  it("isolates independent chains", () => {
    const d = new LoopDetector();
    d.record("a", "p", true);
    d.record("a", "p", true);
    d.record("a", "p", true);
    expect(d.shouldHalt("a", "p")).toBe(true);
    expect(d.shouldHalt("b", "q")).toBe(false);
  });

  it("reset() clears the chain", () => {
    const d = new LoopDetector();
    d.record("a", "x", true);
    d.record("a", "x", true);
    d.record("a", "x", true);
    d.reset("a");
    expect(d.shouldHalt("a", "x")).toBe(false);
  });
});
