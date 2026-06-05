import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

/**
 * Minimal ChildProcess stand-in for the reconcile child. The supervisor only
 * touches `.stderr` (a readable-ish emitter), `.on("error"|"close")`, and the
 * shutdown path reads `.exitCode` + calls `.kill`. We model SIGTERM as the
 * graceful path: the real child finishes its current native batch, then exits
 * — here, killing ends stderr and emits `close(0)`, flipping `exitCode` to 0.
 */
function fakeReconcileChild() {
  const stderr = new EventEmitter() as EventEmitter & { setEncoding(): void };
  stderr.setEncoding = () => undefined;
  const child = new EventEmitter() as EventEmitter & {
    stderr: typeof stderr;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = stderr;
  child.exitCode = null;
  child.kill = vi.fn((sig?: NodeJS.Signals) => {
    void sig;
    child.exitCode = 0;
    stderr.emit("end");
    child.emit("close", 0);
    return true;
  });
  return child;
}

describe("daemon lifecycle (in-process)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-daemon-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(join(home, "entries"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
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

  it("SIGTERMs the live reconcile child on shutdown and exits within grace", async () => {
    const { runDaemon } = await import("./daemon");

    // Inject a fake spawn so the daemon supervises a controllable reconcile
    // child instead of forking a real `daemon reconcile` process.
    const child = fakeReconcileChild();
    const spawn = vi.fn(() => child);

    const exited = runDaemon(spawn as unknown as typeof import("node:child_process").spawn);

    // Wait until the daemon has spawned + is supervising the child (pid file up).
    const pidPath = join(home, "dither.pid");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(pidPath) && spawn.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.exitCode).toBeNull();

    // Clean stop: shutdown must SIGTERM the child and complete well within the
    // 30s grace (the child closes immediately on kill in this stub).
    const stopStart = Date.now();
    process.kill(process.pid, "SIGTERM");
    await exited;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.exitCode).toBe(0);
    expect(Date.now() - stopStart).toBeLessThan(5000);
    expect(existsSync(pidPath)).toBe(false);
  }, 15_000);

  it("readDaemonPid returns null when no daemon is running", async () => {
    const { readDaemonPid } = await import("./daemon-control");
    expect(await readDaemonPid()).toBeNull();
  });

  it("readRunningPlugins skips reserved qmd-*/daemon-start locks", async () => {
    // A live reconcile child holds qmd-embed.lock; daemon-start.lock guards
    // spawns. Neither is a plugin — they must not surface as running.
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", "qmd-embed.lock"), String(process.pid));
    writeFileSync(join(home, "locks", "qmd-index.lock"), String(process.pid));
    writeFileSync(join(home, "locks", "daemon-start.lock"), String(process.pid));
    writeFileSync(join(home, "locks", "hackernews.lock"), String(process.pid));

    const { readRunningPlugins } = await import("./daemon");
    const running = await readRunningPlugins();
    expect(running.map((r) => r.name)).toEqual(["hackernews"]);
  });

  it("getDaemonStatus reports not-running cleanly", async () => {
    const { getDaemonStatus } = await import("./daemon-control");
    const s = await getDaemonStatus();
    expect(s.running).toBe(false);
    expect(s.pid).toBeNull();
  });

  it("uniform boot recover restores orphan inflight + arms refire rows", async () => {
    // No installed plugins → reconcile sets nothing, so watch/schedule recover
    // are no-ops and nothing fires (no deno needed). This isolates the two
    // durable-state recoveries that run on every boot through the uniform
    // recover-all path: the inbox's orphan-inflight restore and the refirer's
    // re-arm of a persisted row.
    mkdirSync(join(home, "inflight"), { recursive: true });
    writeFileSync(
      join(home, "inflight", "ghost.ndjson"),
      `${JSON.stringify({ path: "/g.md", mtime: "2026-05-13T00:00:00.000Z" })}\n`,
    );
    // A refire row due far in the future — recover arms a (long) timer without
    // firing. We assert the inflight restore + that boot completed cleanly.
    mkdirSync(join(home, "refires"), { recursive: true });
    writeFileSync(
      join(home, "refires", "ghost.json"),
      JSON.stringify({ fireAt: new Date(Date.now() + 3_600_000).toISOString(), retryCount: 0, suspended: false }),
    );

    const { runDaemon } = await import("./daemon");
    const exited = runDaemon();

    const inbox = join(home, "inboxes", "ghost.ndjson");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(inbox) && !existsSync(join(home, "inflight", "ghost.ndjson"))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    process.kill(process.pid, "SIGTERM");
    await exited;

    // Inflight restored back into the inbox; lease gone.
    expect(existsSync(inbox)).toBe(true);
    expect(existsSync(join(home, "inflight", "ghost.ndjson"))).toBe(false);
    // The refire row is still on disk (a far-future timer, never fired).
    expect(existsSync(join(home, "refires", "ghost.json"))).toBe(true);
  }, 15_000);

  it("registers schedule from grants and fires runPlugin within ~3s", async () => {
    // Tiny inline plugin with `schedule: "every 1s"`.
    const pluginDir = mkdtempSync(join(tmpdir(), "dither-sched-fixture-"));
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "ticker",
        version: "0.0.1",
        dither: {
          schedule: "every 1s",
          collections: ["ticks"],
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";\nawait writeEntry({ collection: "ticks", filename: "tick-" + Date.now() + ".md", body: "hi" });\n`,
    );

    const { installPlugin } = await import("./plugin-install");
    await installPlugin({ source: pluginDir });

    const { runDaemon } = await import("./daemon");
    const { listRuns } = await import("./run-log");

    const exited = runDaemon();
    await new Promise((r) => setTimeout(r, 3500));
    process.kill(process.pid, "SIGTERM");
    await exited;

    const runs = await listRuns(50);
    const tickerRuns = runs.filter((r) => r.plugin === "ticker");
    expect(tickerRuns.length).toBeGreaterThanOrEqual(2);
    expect(tickerRuns.every((r) => r.status === "ok")).toBe(true);

    rmSync(pluginDir, { recursive: true, force: true });
  }, 30_000);
});

describe("daemon control (no daemon)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-daemon-spawn-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.resetModules();
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("stopDaemon is a clean no-op when nothing is running", async () => {
    const { stopDaemon } = await import("./daemon-control");
    const result = await stopDaemon(1000);
    expect(result.pid).toBeNull();
    expect(result.stopped).toBe(false);
  });

  it("does not signal an unrelated live pid from a stale pid file", async () => {
    writeFileSync(join(home, "dither.pid"), String(process.pid));
    const kill = vi.spyOn(process, "kill");

    const { readDaemonPid, stopDaemon } = await import("./daemon-control");

    await expect(readDaemonPid()).resolves.toBeNull();
    await expect(stopDaemon(1000)).resolves.toEqual({ stopped: false, pid: null });
    expect(kill).not.toHaveBeenCalled();
  });

  it("serializes concurrent daemon starts", async () => {
    vi.resetModules();
    const pid = 12345;
    const startedAt = new Date().toISOString();
    const token = "test-token";
    const kill = vi.spyOn(process, "kill").mockImplementation(((target, signal) => {
      if (signal === 0) return true;
      throw new Error(`unexpected signal ${String(signal)} to ${String(target)}`);
    }) as typeof process.kill);
    const spawn = vi.fn(() => {
      setTimeout(() => {
        writeFileSync(join(home, "dither.pid"), JSON.stringify({ pid, token, startedAt }));
        writeFileSync(
          join(home, "status.json"),
          JSON.stringify({
            pid,
            token,
            startedAt,
            lastUpdated: new Date().toISOString(),
            version: "0.0.1",
            schedules: 0,
            watches: 0,
            running: [],
            recentRuns: [],
            recentHalts: [],
            scheduleEntries: [],
            watchEntries: [],
          }),
        );
      }, 50);
      return { pid, unref: () => undefined };
    });
    vi.doMock("node:child_process", () => ({ spawn }));

    const { startDaemon } = await import("./daemon-control");
    const results = await Promise.all([startDaemon(), startDaemon()]);

    expect(results.map((r) => r.pid)).toEqual([pid, pid]);
    expect(results.map((r) => r.alreadyRunning).toSorted()).toEqual([false, true]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalled();
  });
});
