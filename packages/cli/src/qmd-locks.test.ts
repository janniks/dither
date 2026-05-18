import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QMD_LOCK_THEMES,
  qmdLockPath,
  qmdLockStatus,
  releaseQmdLock,
  tryAcquireQmdLock,
} from "./qmd-locks";

describe("qmd-locks", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-qmd-locks-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("QMD_LOCK_THEMES enumerates the three themes in stable order", () => {
    expect(QMD_LOCK_THEMES).toEqual(["download", "index", "embed"]);
  });

  it("qmdLockPath returns the expected per-theme file under <home>/locks/", () => {
    expect(qmdLockPath("download")).toBe(join(home, "locks", "qmd-download.lock"));
    expect(qmdLockPath("index")).toBe(join(home, "locks", "qmd-index.lock"));
    expect(qmdLockPath("embed")).toBe(join(home, "locks", "qmd-embed.lock"));
  });

  it("status is empty on a fresh home", () => {
    expect(qmdLockStatus()).toEqual({});
  });

  it("tryAcquireQmdLock returns a handle on success and busy on second attempt", async () => {
    const first = await tryAcquireQmdLock("index");
    expect(first.busy).toBe(false);
    if (first.busy) throw new Error("unreachable"); // type guard

    // Second attempt from the same process — non-blocking acquire fails
    // because the file already exists with our PID.
    const second = await tryAcquireQmdLock("index");
    expect(second.busy).toBe(true);
    if (!second.busy) throw new Error("unreachable");
    expect(second.theme).toBe("index");
    expect(second.startedAt).toBeInstanceOf(Date);

    await releaseQmdLock(first);

    // After release, acquire succeeds again.
    const third = await tryAcquireQmdLock("index");
    expect(third.busy).toBe(false);
    if (!third.busy) await releaseQmdLock(third);
  });

  it("status reports the holder per theme", async () => {
    const dl = await tryAcquireQmdLock("download");
    expect(dl.busy).toBe(false);
    if (dl.busy) throw new Error("unreachable");

    const status = qmdLockStatus();
    expect(status.download?.pid).toBe(process.pid);
    expect(status.download?.startedAt).toBeInstanceOf(Date);
    expect(status.index).toBeUndefined();
    expect(status.embed).toBeUndefined();

    await releaseQmdLock(dl);
  });

  it("each theme can be held independently", async () => {
    const dl = await tryAcquireQmdLock("download");
    const ix = await tryAcquireQmdLock("index");
    const em = await tryAcquireQmdLock("embed");
    expect(dl.busy).toBe(false);
    expect(ix.busy).toBe(false);
    expect(em.busy).toBe(false);
    const status = qmdLockStatus();
    expect(status.download).toBeDefined();
    expect(status.index).toBeDefined();
    expect(status.embed).toBeDefined();
    if (!dl.busy) await releaseQmdLock(dl);
    if (!ix.busy) await releaseQmdLock(ix);
    if (!em.busy) await releaseQmdLock(em);
    expect(qmdLockStatus()).toEqual({});
  });

  it("releaseQmdLock is idempotent", async () => {
    const handle = await tryAcquireQmdLock("embed");
    expect(handle.busy).toBe(false);
    if (handle.busy) throw new Error("unreachable");
    await releaseQmdLock(handle);
    await releaseQmdLock(handle); // second release is a no-op
    expect(qmdLockStatus()).toEqual({});
  });
});
