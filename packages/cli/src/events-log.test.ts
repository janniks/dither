import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROTATION_THRESHOLD_BYTES,
  appendEvent,
  eventsLogOldPath,
  eventsLogPath,
  followEvents,
  readEvents,
  truncateEventsLog,
} from "./events-log";

describe("events-log", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-events-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("appendEvent writes a JSONL line with a timestamp", async () => {
    await appendEvent({ kind: "daemon-started", pid: 1234 });
    const path = eventsLogPath();
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.kind).toBe("daemon-started");
    expect(parsed.pid).toBe(1234);
    expect(typeof parsed.ts).toBe("string");
    expect(new Date(parsed.ts).getTime()).toBeGreaterThan(0);
  });

  it("multiple appends produce one line per event", async () => {
    await appendEvent({ kind: "a" });
    await appendEvent({ kind: "b" });
    await appendEvent({ kind: "c" });
    const events = await readEvents();
    expect(events.map((e) => e.kind)).toEqual(["a", "b", "c"]);
  });

  it("readEvents with tailLines caps from the end", async () => {
    for (let i = 0; i < 10; i++) {
      await appendEvent({ kind: "tick", i });
    }
    const tail = await readEvents(3);
    expect(tail.map((e) => e.i)).toEqual([7, 8, 9]);
  });

  it("readEvents returns empty array when no log exists", async () => {
    expect(await readEvents()).toEqual([]);
  });

  it("truncateEventsLog clears current and removes rotated copy", async () => {
    await appendEvent({ kind: "x" });
    // Manually create a rotated copy.
    writeFileSync(eventsLogOldPath(), "stale\n", "utf-8");
    await truncateEventsLog();
    expect(existsSync(eventsLogPath())).toBe(true);
    expect(statSync(eventsLogPath()).size).toBe(0);
    expect(existsSync(eventsLogOldPath())).toBe(false);
  });

  it("rotation: appends past the threshold rotate to .old and start fresh", async () => {
    // Hand-craft a file that already weighs more than the threshold.
    const path = eventsLogPath();
    writeFileSync(path, "x".repeat(ROTATION_THRESHOLD_BYTES + 10), "utf-8");
    await appendEvent({ kind: "post-rotation" });
    expect(existsSync(eventsLogOldPath())).toBe(true);
    // New log contains only the post-rotation event.
    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("post-rotation");
  });

  it("malformed lines are skipped, not crashed on", async () => {
    const path = eventsLogPath();
    // Manually write a mix of valid + garbage lines.
    writeFileSync(
      path,
      `${JSON.stringify({ ts: "2026-01-01T00:00:00Z", kind: "ok" })}\nnot-json\n${JSON.stringify({ ts: "2026-01-02T00:00:00Z", kind: "ok2" })}\n`,
      "utf-8",
    );
    const events = await readEvents();
    expect(events.map((e) => e.kind)).toEqual(["ok", "ok2"]);
  });

  it("followEvents yields events appended after the follower starts", async () => {
    // Pre-existing events shouldn't be yielded — follower starts at end.
    await appendEvent({ kind: "before-follow" });
    const ac = new AbortController();
    const collected: string[] = [];
    const iter = followEvents(ac.signal);
    const consume = (async () => {
      for await (const e of iter) {
        collected.push(e.kind);
        if (collected.length >= 2) ac.abort();
      }
    })();
    // Brief delay to let the follower seek to end.
    await new Promise((r) => setTimeout(r, 150));
    await appendEvent({ kind: "after-1" });
    await appendEvent({ kind: "after-2" });
    await consume;
    expect(collected).toEqual(["after-1", "after-2"]);
  });

  it("followEvents handles truncation (daemon restart) by reopening at start", async () => {
    await appendEvent({ kind: "before-trunc" });
    const ac = new AbortController();
    const collected: string[] = [];
    const iter = followEvents(ac.signal);
    const consume = (async () => {
      for await (const e of iter) {
        collected.push(e.kind);
        if (collected.length >= 1) ac.abort();
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    await truncateEventsLog();
    await appendEvent({ kind: "post-trunc" });
    await consume;
    expect(collected).toEqual(["post-trunc"]);
  });

  it("followEvents reopens when rotation replaces the log path", async () => {
    writeFileSync(eventsLogPath(), "x".repeat(ROTATION_THRESHOLD_BYTES), "utf-8");
    const ac = new AbortController();
    const collected: string[] = [];
    const iter = followEvents(ac.signal);
    const consume = (async () => {
      for await (const e of iter) {
        collected.push(e.kind);
        ac.abort();
      }
    })();
    const timeout = setTimeout(() => ac.abort(), 3_000);
    await new Promise((r) => setTimeout(r, 150));
    await appendEvent({ kind: "post-rotation" });
    await consume;
    clearTimeout(timeout);
    expect(collected).toEqual(["post-rotation"]);
  });
});
