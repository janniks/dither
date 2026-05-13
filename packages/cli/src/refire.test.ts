import { describe, it, expect } from "vitest";
import { decideRunOutcome, POISON_PILL_THRESHOLD } from "./refire";

const T = Date.parse("2026-05-13T12:00:00.000Z");

describe("decideRunOutcome", () => {
  it("clean exit without reschedule → cleared", () => {
    expect(
      decideRunOutcome({ exitCode: 0, rescheduleMs: null, prior: null, now: T }),
    ).toEqual({ kind: "ok-cleared" });
  });

  it("clean exit with reschedule → schedules refire, retry counter reset", () => {
    const out = decideRunOutcome({
      exitCode: 0,
      rescheduleMs: 300_000,
      rescheduleReason: "rate limit",
      prior: { fireAt: "x", retryCount: 1, suspended: false },
      now: T,
    });
    expect(out.kind).toBe("ok-rescheduled");
    if (out.kind !== "ok-rescheduled") throw new Error("unreachable");
    expect(out.row.retryCount).toBe(0);
    expect(out.row.suspended).toBe(false);
    expect(out.row.reason).toBe("rate limit");
    expect(out.row.fireAt).toBe(new Date(T + 300_000).toISOString());
  });

  it("clean exit with reschedule < 1s → clamped to 1s", () => {
    const out = decideRunOutcome({ exitCode: 0, rescheduleMs: 100, prior: null, now: T });
    if (out.kind !== "ok-rescheduled") throw new Error("unreachable");
    expect(out.row.fireAt).toBe(new Date(T + 1000).toISOString());
  });

  it("non-zero exit with no prior → first retry, 1m backoff", () => {
    const out = decideRunOutcome({ exitCode: 1, rescheduleMs: null, prior: null, now: T });
    expect(out.kind).toBe("failed-retry");
    if (out.kind !== "failed-retry") throw new Error("unreachable");
    expect(out.row.retryCount).toBe(1);
    expect(out.row.fireAt).toBe(new Date(T + 60_000).toISOString());
  });

  it("non-zero exit, second retry, 5m backoff", () => {
    const out = decideRunOutcome({
      exitCode: 1,
      rescheduleMs: null,
      prior: { fireAt: "x", retryCount: 1, suspended: false },
      now: T,
    });
    if (out.kind !== "failed-retry") throw new Error("unreachable");
    expect(out.row.retryCount).toBe(2);
    expect(out.row.fireAt).toBe(new Date(T + 5 * 60_000).toISOString());
  });

  it(`non-zero exit reaches ${POISON_PILL_THRESHOLD}-strikes → suspended`, () => {
    const out = decideRunOutcome({
      exitCode: 1,
      rescheduleMs: null,
      prior: { fireAt: "x", retryCount: POISON_PILL_THRESHOLD - 1, suspended: false },
      now: T,
    });
    expect(out.kind).toBe("failed-suspended");
    if (out.kind !== "failed-suspended") throw new Error("unreachable");
    expect(out.row.suspended).toBe(true);
    expect(out.row.retryCount).toBe(POISON_PILL_THRESHOLD);
  });
});
