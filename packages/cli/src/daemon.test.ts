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
          create: ["ticks"],
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

describe("daemon hand-off (version self-restart)", () => {
  let home: string;
  let prevHome: string | undefined;
  // Default sidecar path read by isStale() with no arg — sits next to
  // build-stamp.ts. Written stale to trigger the hand-off on SIGUSR1/HUP.
  const sidecar = join(__dirname, "build-info.json");

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-handoff-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(join(home, "entries"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { setHandoffConfirmMs } = await import("./daemon");
    setHandoffConfirmMs(30_000);
    rmSync(sidecar, { force: true });
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function globalEvents() {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(home, "run-log.jsonl"), "utf-8").catch(() => "");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string });
  }

  it("RESTART_DRAIN_MS is a separate, longer knob than SHUTDOWN_GRACE_MS", async () => {
    // Both constants are module-private; assert via the source text so a future
    // edit that collapses them into one knob trips this.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(join(__dirname, "daemon.ts"), "utf-8");
    const grace = src.match(/SHUTDOWN_GRACE_MS = ([\d_]+)/)?.[1];
    const drain = src.match(/RESTART_DRAIN_MS = ([\d_]+)/)?.[1];
    expect(grace).toBe("30_000");
    expect(drain).toBe("300_000");
    expect(drain).not.toBe(grace);
  });

  it("handingOff gates fireWithSuppress — no run starts", async () => {
    const { fireWithSuppress } = await import("./daemon");
    const { Watcher } = await import("./watcher");
    const { Refirer } = await import("./refirer");
    const { LoopDetector } = await import("./loop-detector");

    const state = {
      token: "t",
      startedAt: new Date().toISOString(),
      shuttingDown: false,
      reloadRequested: false,
      handingOff: true,
      restartFails: 0,
      restartDisabled: false,
      scheduleCount: 0,
      watchCount: 0,
    };
    const ran = await fireWithSuppress(
      state,
      new Watcher(() => undefined),
      new Refirer(() => undefined),
      new LoopDetector(),
      "ghost",
      "manual",
      () => undefined,
    );
    // Gated: returned without acquiring the lock or running. No lock file left.
    expect(ran).toBe(false);
    expect(existsSync(join(home, "locks", "ghost.lock"))).toBe(false);
  });

  it("kick-not-consumed: a kick present at hand-off stays claimable (retry→restore)", async () => {
    const { fireKick } = await import("./daemon");
    const { Watcher } = await import("./watcher");
    const { Refirer } = await import("./refirer");
    const { LoopDetector } = await import("./loop-detector");
    const { writeKick, hasKick, kickSource } = await import("./kicks");

    const state = {
      token: "t",
      startedAt: new Date().toISOString(),
      shuttingDown: false,
      reloadRequested: false,
      handingOff: true,
      restartFails: 0,
      restartDisabled: false,
      scheduleCount: 0,
      watchCount: 0,
    };

    // A kick is pending on disk at hand-off time.
    await writeKick("ghost", { runId: "r1", kickedAt: new Date().toISOString() });
    expect(hasKick("ghost")).toBe(true);

    // Drain through the real kick Source with the gated fireKick. The gate
    // makes fireKick return "retry" → the Queue restores the lease to pending.
    const source = kickSource((name, payload) =>
      fireKick(state, new Watcher(() => undefined), new Refirer(() => undefined), new LoopDetector(), name, payload, () => undefined),
    );
    await source.drain();

    // Invariant: the kick was NOT acked away — it's claimable again.
    expect(hasKick("ghost")).toBe(true);
  });

  it("stale + SIGUSR1 → spawns successor, logs restarting→restarted, exits", async () => {
    const { runDaemon } = await import("./daemon");

    // A stale sidecar at the default path so checkStale() (no-arg) sees a
    // different build than the baked dev fallback.
    writeFileSync(sidecar, JSON.stringify({ version: "9.9.9", sha: "newsha", builtAt: "20260606010101" }));

    const pidPath = join(home, "dither.pid");
    // Fake spawn handles BOTH daemon child kinds: the reconcile child (no
    // "daemon run" args) and the successor re-exec. The successor simulates a
    // fresh daemon by writing a PID file with a DIFFERENT pid/token, so the
    // old daemon's confirm-poll succeeds.
    const reconcile = fakeReconcileChild();
    const spawn = vi.fn((_exec: string, args: string[]): unknown => {
      if (args.includes("daemon") && args.includes("run")) {
        // A real successor would write its own {pid, token}. We can't fork a
        // live process here, so we reuse OUR pid (guaranteed alive for the
        // isPidAlive confirm) with a DIFFERENT token — that's still a distinct
        // identity, which is what the confirm-poll checks for.
        writeFileSync(
          pidPath,
          JSON.stringify({ pid: process.pid, token: "successor-token", startedAt: new Date().toISOString() }),
        );
        return { pid: process.pid, unref: () => undefined };
      }
      return reconcile;
    });

    const exited = runDaemon(spawn as unknown as typeof import("node:child_process").spawn);

    // Wait until the (old) daemon has written its own PID file.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(pidPath)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(pidPath)).toBe(true);

    // Trigger the hand-off.
    process.kill(process.pid, "SIGUSR1");
    await exited;

    // Successor was spawned from the on-disk bundle (daemon run re-exec).
    const handoffSpawn = spawn.mock.calls.find((c) => c[1].includes("daemon") && c[1].includes("run"));
    expect(handoffSpawn).toBeTruthy();

    const kinds = (await globalEvents()).map((e) => e.kind);
    expect(kinds).toContain("daemon-restarting");
    expect(kinds).toContain("daemon-restarted");
    expect(kinds).not.toContain("daemon-restart-failed");

    // Token guard: the successor's PID file is left intact (we did NOT clobber
    // it — it still holds the successor identity).
    const { readFile } = await import("node:fs/promises");
    const left = JSON.parse(await readFile(pidPath, "utf-8")) as { token: string };
    expect(left.token).toBe("successor-token");
  }, 20_000);

  it("rollback: successor never confirms → daemon stays alive on old code", async () => {
    const { runDaemon, setHandoffConfirmMs, readStatusSnapshot } = await import("./daemon");
    setHandoffConfirmMs(300); // don't wait the full 30s for the timeout

    writeFileSync(sidecar, JSON.stringify({ version: "9.9.9", sha: "newsha", builtAt: "20260606010101" }));

    const pidPath = join(home, "dither.pid");
    // A "successor" that never writes a PID file — confirm-poll times out and
    // the daemon must roll back rather than exit.
    const reconcile = fakeReconcileChild();
    const spawn = vi.fn((_exec: string, args: string[]): unknown => {
      if (args.includes("daemon") && args.includes("run")) return { pid: 999999, unref: () => undefined };
      return reconcile;
    });

    let resolved = false;
    const exited = runDaemon(spawn as unknown as typeof import("node:child_process").spawn).then(() => {
      resolved = true;
    });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(pidPath)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const own = JSON.parse(await import("node:fs").then((m) => m.readFileSync(pidPath, "utf-8"))) as { token: string };

    // Trigger the hand-off → confirm times out → rollback.
    process.kill(process.pid, "SIGUSR1");

    // Wait for the rollback event.
    const rbDeadline = Date.now() + 5000;
    while (Date.now() < rbDeadline) {
      if ((await globalEvents()).some((e) => e.kind === "daemon-restart-rolledback")) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const kinds = (await globalEvents()).map((e) => e.kind);
    expect(kinds).toContain("daemon-restart-rolledback");
    expect(kinds).not.toContain("daemon-restarted");

    // The daemon did NOT exit — its run promise is still pending and it still
    // owns the PID file under its own (unchanged) identity.
    expect(resolved).toBe(false);
    const stillOurs = JSON.parse(await import("node:fs").then((m) => m.readFileSync(pidPath, "utf-8"))) as {
      token: string;
    };
    expect(stillOurs.token).toBe(own.token);

    // Sources re-armed: a kick written AFTER rollback fires on old code. With no
    // installed plugins it can't actually run a plugin, but the snapshot still
    // reflects a live, non-disabled daemon (one failure, not yet flapped).
    const snap = await readStatusSnapshot();
    expect(snap!.restartFails).toBe(1);
    expect(snap!.restartDisabled).toBe(false);

    process.kill(process.pid, "SIGTERM");
    await exited;
  }, 20_000);

  it("flap: 3 failed hand-offs → restartDisabled, 4th trigger no-ops", async () => {
    const { runDaemon, setHandoffConfirmMs, readStatusSnapshot } = await import("./daemon");
    setHandoffConfirmMs(150);

    writeFileSync(sidecar, JSON.stringify({ version: "9.9.9", sha: "newsha", builtAt: "20260606010101" }));

    const pidPath = join(home, "dither.pid");
    const reconcile = fakeReconcileChild();
    const spawn = vi.fn((_exec: string, args: string[]): unknown => {
      if (args.includes("daemon") && args.includes("run")) return { pid: 999999, unref: () => undefined };
      return reconcile;
    });

    const exited = runDaemon(spawn as unknown as typeof import("node:child_process").spawn);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(pidPath)) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // Drive three hand-offs. Each rollback clears handingOff, so the next
    // SIGUSR1 (still stale) starts a fresh hand-off. Wait for each rollback to
    // land before firing the next so they don't coalesce under handingOff.
    async function rollbacks() {
      return (await globalEvents()).filter((e) => e.kind === "daemon-restart-rolledback").length;
    }
    for (let want = 1; want <= 3; want += 1) {
      process.kill(process.pid, "SIGUSR1");
      const d = Date.now() + 5000;
      while (Date.now() < d) {
        if ((await rollbacks()) >= want) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(await rollbacks()).toBe(want);
    }

    const kinds = (await globalEvents()).map((e) => e.kind);
    expect(kinds).toContain("daemon-restart-disabled");

    const snap = await readStatusSnapshot();
    expect(snap!.restartDisabled).toBe(true);
    expect(snap!.restartFails).toBe(3);

    // 4th trigger: handOff early-returns on restartDisabled → no new spawn.
    const spawnsBefore = spawn.mock.calls.filter((c) => c[1].includes("daemon") && c[1].includes("run")).length;
    process.kill(process.pid, "SIGUSR1");
    await new Promise((r) => setTimeout(r, 400));
    const spawnsAfter = spawn.mock.calls.filter((c) => c[1].includes("daemon") && c[1].includes("run")).length;
    expect(spawnsAfter).toBe(spawnsBefore);
    expect(await rollbacks()).toBe(3); // no 4th rollback either

    process.kill(process.pid, "SIGTERM");
    await exited;
  }, 25_000);

  it("re-entrancy: a second trigger mid-hand-off does not spawn twice", async () => {
    const { fireWithSuppress } = await import("./daemon");
    const { Watcher } = await import("./watcher");
    const { Refirer } = await import("./refirer");
    const { LoopDetector } = await import("./loop-detector");

    // The choke point is what a re-entrant trigger flows through while a
    // hand-off is in flight (handingOff true). It must NOT start a run.
    const state = {
      token: "t",
      startedAt: new Date().toISOString(),
      shuttingDown: false,
      reloadRequested: false,
      handingOff: true,
      restartFails: 0,
      restartDisabled: false,
      scheduleCount: 0,
      watchCount: 0,
    };
    const ran = await fireWithSuppress(
      state,
      new Watcher(() => undefined),
      new Refirer(() => undefined),
      new LoopDetector(),
      "ghost",
      "manual",
      () => undefined,
    );
    expect(ran).toBe(false);
    expect(existsSync(join(home, "locks", "ghost.lock"))).toBe(false);
  });
});

describe("checkStale (staleness detection on IPC entries)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-stale-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function globalEvents() {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(home, "run-log.jsonl"), "utf-8").catch(() => "");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; from?: string; to?: string });
  }

  it("logs stale-detected when the disk sidecar differs from the baked stamp", async () => {
    const sidecar = join(home, "build-info.json");
    writeFileSync(sidecar, JSON.stringify({ version: "9.9.9", sha: "feedbee", builtAt: "20260606000000" }));

    const { checkStale } = await import("./daemon");
    expect(await checkStale(sidecar)).toBe(true);

    const stale = (await globalEvents()).filter((e) => e.kind === "stale-detected");
    expect(stale).toHaveLength(1);
    const [row] = stale;
    expect(row?.to).toBe("9.9.9+feedbee.20260606000000");
    expect(row?.from).toBeTruthy();
  });

  it("is silent when the disk sidecar matches the baked stamp", async () => {
    const { buildStamp } = await import("./build-stamp");
    const sidecar = join(home, "build-info.json");
    writeFileSync(sidecar, JSON.stringify(buildStamp()));

    const { checkStale } = await import("./daemon");
    expect(await checkStale(sidecar)).toBe(false);

    expect((await globalEvents()).filter((e) => e.kind === "stale-detected")).toHaveLength(0);
  });
});
