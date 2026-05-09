import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("locks", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-locks-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.DITHER_DIR;
    } else {
      process.env.DITHER_DIR = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("acquires and releases cleanly", async () => {
    const { acquire, release } = await import("./locks");
    const handle = await acquire("alpha");
    expect(handle).not.toBeNull();
    expect(existsSync(join(home, "locks", "alpha.lock"))).toBe(true);

    await release(handle!);
    expect(existsSync(join(home, "locks", "alpha.lock"))).toBe(false);
  });

  it("returns null when the lock is held by a live process", async () => {
    const { acquire } = await import("./locks");
    const first = await acquire("contended");
    expect(first).not.toBeNull();

    const second = await acquire("contended");
    expect(second).toBeNull();
  });

  it("two concurrent acquires resolve to exactly one winner", async () => {
    const { acquire } = await import("./locks");
    const [a, b] = await Promise.all([acquire("race"), acquire("race")]);
    const winners = [a, b].filter((h): h is NonNullable<typeof a> => h !== null);
    expect(winners).toHaveLength(1);
  });

  it("reclaims a lock whose PID is dead", async () => {
    // Plant a fake stale lock with a PID we know is dead. Use 1 — init/launchd —
    // but verify it's not the current process; if by some accident process.pid
    // === 1 (extremely rare in dev) skip the test.
    if (process.pid === 1) return;

    // Find a PID that is reliably dead. Spawn a child and wait for it to exit.
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync("true");
    const deadPid = child.pid;
    expect(deadPid).toBeDefined();

    // Plant the stale lock.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", "stale.lock"), String(deadPid));

    const { acquire } = await import("./locks");
    const handle = await acquire("stale");
    expect(handle).not.toBeNull();
    expect(handle!.pid).toBe(process.pid);

    const written = readFileSync(join(home, "locks", "stale.lock"), "utf-8");
    expect(Number.parseInt(written, 10)).toBe(process.pid);
  });

  it("release is a no-op when the lock has been stale-reclaimed by someone else", async () => {
    const { acquire, release } = await import("./locks");
    const handle = await acquire("reclaimed");
    expect(handle).not.toBeNull();

    // Simulate another process reclaiming: rewrite the lock with a different PID.
    writeFileSync(join(home, "locks", "reclaimed.lock"), "999999");

    // release() should detect the mismatch and not unlink.
    await release(handle!);
    expect(existsSync(join(home, "locks", "reclaimed.lock"))).toBe(true);
  });

  it("release is idempotent against an already-removed lock", async () => {
    const { acquire, release } = await import("./locks");
    const handle = await acquire("missing");
    expect(handle).not.toBeNull();

    // External cleanup.
    rmSync(handle!.path, { force: true });

    // No throw.
    await release(handle!);
  });
});
