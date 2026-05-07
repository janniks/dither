import { describe, it, expect } from "vitest";
import { parseSchedule } from "./schedule-parser";

describe("parseSchedule", () => {
  it.each([
    ["every 1s", "*/1 * * * * *"],
    ["every 30s", "*/30 * * * * *"],
    ["every 5m", "0 */5 * * * *"],
    ["every 15 minutes", "0 */15 * * * *"],
    ["every 2h", "0 0 */2 * * *"],
    ["daily at 9am", "0 9 * * *"],
    ["daily at 12pm", "0 12 * * *"],
    ["daily at 12am", "0 0 * * *"],
    ["daily at 09:30", "30 9 * * *"],
    ["daily at 14:00", "0 14 * * *"],
  ])("parses %s as %s", (input, expected) => {
    expect(parseSchedule(input)).toBe(expected);
  });

  it("passes raw cron through", () => {
    expect(parseSchedule("0 9 * * 1-5")).toBe("0 9 * * 1-5");
    expect(parseSchedule("*/10 * * * * *")).toBe("*/10 * * * * *");
  });

  it("rejects empty input", () => {
    expect(() => parseSchedule("")).toThrow();
  });

  it("rejects out-of-range intervals", () => {
    expect(() => parseSchedule("every 90s")).toThrow();
    expect(() => parseSchedule("every 25h")).toThrow();
  });
});
