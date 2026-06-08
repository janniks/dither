import { describe, it, expect } from "vitest";
import { normalizeSchedule } from "./command-plugin-run";
import { parseSchedule } from "../schedule-parser";
import { Cron } from "croner";

describe("normalizeSchedule (--every)", () => {
  it("prefixes a bare duration so parseSchedule accepts it", () => {
    expect(normalizeSchedule("10m")).toBe("every 10m");
    expect(normalizeSchedule("15min")).toBe("every 15min");
    expect(normalizeSchedule("2h")).toBe("every 2h");
    expect(normalizeSchedule(" 30s ")).toBe("every 30s");
  });

  it("leaves cron and 'every'/'daily' forms untouched", () => {
    expect(normalizeSchedule("0 */6 * * *")).toBe("0 */6 * * *");
    expect(normalizeSchedule("every 15min")).toBe("every 15min");
    expect(normalizeSchedule("daily at 9am")).toBe("daily at 9am");
  });

  it("produces a string the scheduler can actually parse and run", () => {
    for (const input of ["10m", "every 15min", "0 */6 * * *", "daily at 9am"]) {
      expect(() => new Cron(parseSchedule(normalizeSchedule(input)))).not.toThrow();
    }
  });
});
