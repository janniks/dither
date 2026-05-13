import { describe, it, expect } from "vitest";
import { formatRelTime } from "./relative-time";

describe("formatRelTime", () => {
  const now = Date.parse("2026-05-13T12:00:00.000Z");

  const cases: Array<[string, number, string]> = [
    ["sub-second → now", 500, "now"],
    ["1 second", 1_000, "in 1s"],
    ["45 seconds", 45_000, "in 45s"],
    ["1 minute exact", 60_000, "in 1m"],
    ["2 minutes 5 seconds", 2 * 60_000 + 5_000, "in 2m 5s"],
    ["1 hour exact", 60 * 60_000, "in 1h"],
    ["2 hours 15 minutes", 2 * 60 * 60_000 + 15 * 60_000, "in 2h 15m"],
    ["1 day exact", 24 * 60 * 60_000, "in 1d"],
    ["3 days 4 hours", 3 * 24 * 60 * 60_000 + 4 * 60 * 60_000, "in 3d 4h"],
    ["past → now", -10_000, "now"],
  ];

  for (const [label, deltaMs, expected] of cases) {
    it(label, () => {
      expect(formatRelTime(now + deltaMs, now)).toBe(expected);
    });
  }
});
