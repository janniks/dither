import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("watch-state", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-watchstate-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("readWatermark is empty before any advance", async () => {
    const { readWatermark, watchKey } = await import("./watch-state");
    expect(await readWatermark(watchKey("p", "messages"))).toBe("");
  });

  it("advanceWatermark records and reads back the mtime", async () => {
    const { advanceWatermark, readWatermark, watchKey } = await import("./watch-state");
    const key = watchKey("p", "messages");
    await advanceWatermark(key, "2026-05-13T00:00:01.000Z");
    expect(await readWatermark(key)).toBe("2026-05-13T00:00:01.000Z");
  });

  it("advanceWatermark is monotonic — an older mtime never lowers it", async () => {
    const { advanceWatermark, readWatermark, watchKey } = await import("./watch-state");
    const key = watchKey("p", "messages");
    await advanceWatermark(key, "2026-05-13T00:00:05.000Z");
    await advanceWatermark(key, "2026-05-13T00:00:01.000Z");
    expect(await readWatermark(key)).toBe("2026-05-13T00:00:05.000Z");
  });

  it("watchKey sanitizes path-unsafe collection names", async () => {
    const { watchKey } = await import("./watch-state");
    expect(watchKey("p", "a/b")).toBe("p__a_b");
    expect(watchKey("p", "./rel")).toBe("p__._rel");
  });
});
