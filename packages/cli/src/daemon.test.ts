import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("daemon lifecycle (in-process)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-daemon-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("runDaemon writes pid + snapshot, exits cleanly on SIGTERM", async () => {
    const { runDaemon, readStatusSnapshot } = await import("./daemon");

    const exited = runDaemon();

    // Wait for pid file + snapshot.
    const pidPath = join(home, "dither.pid");
    const snapPath = join(home, "status.json");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(pidPath) && existsSync(snapPath)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(pidPath)).toBe(true);
    const snap = await readStatusSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.pid).toBe(process.pid);

    // Send SIGTERM to ourselves; the daemon registered a handler.
    process.kill(process.pid, "SIGTERM");
    await exited;
    expect(existsSync(pidPath)).toBe(false);
  }, 15_000);

  it("readDaemonPid returns null when no daemon is running", async () => {
    const { readDaemonPid } = await import("./daemon-control");
    expect(await readDaemonPid()).toBeNull();
  });

  it("getDaemonStatus reports not-running cleanly", async () => {
    const { getDaemonStatus } = await import("./daemon-control");
    const s = await getDaemonStatus();
    expect(s.running).toBe(false);
    expect(s.pid).toBeNull();
  });
});

describe("daemon control (no daemon)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-daemon-spawn-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("stopDaemon is a clean no-op when nothing is running", async () => {
    const { stopDaemon } = await import("./daemon-control");
    const result = await stopDaemon(1000);
    expect(result.pid).toBeNull();
    expect(result.stopped).toBe(false);
  });
});
