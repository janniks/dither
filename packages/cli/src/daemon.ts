import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pidFilePath, statusSnapshotPath, locksDirPath, resolveHome } from "./home";
import { libraryRoot as resolveLibraryRoot } from "./config";
import { appendGlobal, listRuns, truncateGlobal, type RunSummary } from "./run-log";
import { listPlugins, type InstalledPluginInfo } from "./plugin-list";
import { Scheduler, type ScheduleEntry } from "./scheduler";
import { Watcher, type WatchEntry } from "./watcher";
import { runPlugin } from "./plugin-run";
import { LoopDetector, type HaltRecord } from "./loop-detector";
import { inboxHasItems, recoverOrphanInflight } from "./inbox";
import { Refirer } from "./refirer";
import { readRefire } from "./refire";
import { scanKicks, type KickPayload } from "./kicks";
import { acquire as acquireLock, release as releaseLock } from "./locks";
import { clearInflightJobs } from "./daemon-jobs";
import { superviseReconcile } from "./reconcile-supervisor";
import { needsReindexPath } from "./markers";
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * Long-lived daemon process. The status snapshot is event-driven — written
 * at startup, SIGHUP reload, run start/end, loop-detector halt, and shutdown.
 * No periodic heartbeat; liveness is the pid file + `kill(pid, 0)` + token
 * match. `lastUpdated` on the snapshot tells the user how fresh it is.
 */

const SHUTDOWN_GRACE_MS = 30_000;

export interface StatusSnapshot {
  pid: number;
  token: string;
  startedAt: string;
  lastUpdated: string;
  version: string;
  schedules: number;
  watches: number;
  running: RunningPlugin[];
  recentRuns: RunSummary[];
  recentHalts: HaltRecord[];
  scheduleEntries: Array<{ name: string; pattern: string; nextRun: string | null }>;
  watchEntries: Array<{ name: string; collections: string[]; glob: string }>;
}

export interface RunningPlugin {
  name: string;
  pid: number;
}

interface DaemonState {
  token: string;
  startedAt: string;
  shuttingDown: boolean;
  reloadRequested: boolean;
  scheduleCount: number;
  watchCount: number;
}

function scheduleEntriesOf(plugins: InstalledPluginInfo[]): ScheduleEntry[] {
  return plugins.flatMap((p) => (p.schedule ? [{ name: p.name, schedule: p.schedule }] : []));
}

function watchEntriesOf(plugins: InstalledPluginInfo[]): WatchEntry[] {
  return plugins.flatMap((p) => {
    const w = p.watch;
    if (!w || !Array.isArray(w.collections) || w.collections.length === 0) return [];
    return [{ name: p.name, collections: w.collections, ...(w.glob ? { glob: w.glob } : {}) }];
  });
}

interface KickContext {
  runId: string;
  overrides?: KickPayload["overrides"];
}

async function fireWithSuppress(
  watcher: Watcher,
  refirer: Refirer,
  detector: LoopDetector,
  name: string,
  trigger: "scheduled" | "watch" | "manual",
  notify: () => void,
  kick?: KickContext,
): Promise<void> {
  const source = `${trigger}:${name}`;
  if (detector.shouldHalt(source, name)) {
    detector.record(source, name, false);
    console.error(`[daemon] halting ${trigger} fire of '${name}' — loop threshold reached`);
    notify();
    return;
  }
  detector.record(source, name, true);

  // Single-arbiter for "is this plugin running right now". All four fire
  // sources (Scheduler, Watcher, Refirer, kick path) flow through here, so
  // a contested plugin fires in lock-acquire order rather than fanning out.
  // The lock used to live in `runPlugin`; moving it here makes runPlugin a
  // pure orchestrator that doesn't import locks at all.
  const lock = await acquireLock(name);
  if (!lock) {
    console.error(`[daemon] ${trigger} fire of '${name}' skipped — already running`);
    return;
  }
  notify();

  try {
    const result = await runPlugin({
      name,
      trigger,
      ...(kick?.runId ? { runId: kick.runId } : {}),
      ...(kick?.overrides ?? {}),
    });
    for (const path of result.added) watcher.suppressOnce(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[daemon] ${trigger} fire of '${name}' failed: ${message}`);
  } finally {
    await releaseLock(lock);
    notify();
  }

  // Pick up any refire row the run just wrote (plugin asked to be refired,
  // or the post-failure backoff scheduled a retry). Without this, the row
  // sits on disk until SIGHUP / restart.
  const row = await readRefire(name).catch(() => null);
  if (row && !row.suspended) refirer.set(name, Date.parse(row.fireAt));

  // Drain loop: if events landed in the inbox during the run, keep firing
  // until the inbox is empty (or the next event lands a fresh debounce).
  if (trigger === "watch") {
    const stillPending = await inboxHasItems(name).catch(() => false);
    if (stillPending) void fireWithSuppress(watcher, refirer, detector, name, "watch", notify);
  }
}

function fireKick(
  watcher: Watcher,
  refirer: Refirer,
  detector: LoopDetector,
  name: string,
  payload: KickPayload,
  notify: () => void,
): void {
  void fireWithSuppress(watcher, refirer, detector, name, "manual", notify, {
    runId: payload.runId,
    ...(payload.overrides ? { overrides: payload.overrides } : {}),
  });
}

async function writePidFile(state: DaemonState): Promise<void> {
  await mkdir(resolveHome(), { recursive: true });
  await writeFile(
    pidFilePath(),
    `${JSON.stringify({ pid: process.pid, token: state.token, startedAt: state.startedAt })}\n`,
  );
}

async function removePidFile(state: DaemonState): Promise<void> {
  try {
    const raw = await readFile(pidFilePath(), "utf-8");
    const pid = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (pid.pid !== process.pid || pid.token !== state.token) return;
    await unlink(pidFilePath());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
  }
}

async function readRunningPlugins(): Promise<RunningPlugin[]> {
  let entries: string[];
  try {
    entries = await readdir(locksDirPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: RunningPlugin[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(".lock")) continue;
    const name = filename.slice(0, -".lock".length);
    let raw: string;
    try {
      raw = await readFile(join(locksDirPath(), filename), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) out.push({ name, pid });
  }
  return out;
}

export async function readStatusSnapshot(): Promise<StatusSnapshot | null> {
  try {
    const raw = await readFile(statusSnapshotPath(), "utf-8");
    return JSON.parse(raw) as StatusSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeStatusSnapshot(
  state: DaemonState,
  scheduler: Scheduler,
  watcher: Watcher,
  detector: LoopDetector,
): Promise<void> {
  const running = await readRunningPlugins();
  const recentRuns = await listRuns(5).catch(() => []);
  const snapshot: StatusSnapshot = {
    pid: process.pid,
    token: state.token,
    startedAt: state.startedAt,
    lastUpdated: new Date().toISOString(),
    version: "0.0.1",
    schedules: state.scheduleCount,
    watches: state.watchCount,
    running,
    recentRuns,
    recentHalts: detector.recentHalts.slice(0, 5),
    scheduleEntries: scheduler.stats().entries.slice(0, 10),
    watchEntries: watcher.stats().entries.slice(0, 10),
  };
  await mkdir(resolveHome(), { recursive: true });
  await writeFile(statusSnapshotPath(), JSON.stringify(snapshot, null, 2));
}

/**
 * Run the daemon main loop in the current process. Used both by the spawned
 * detached daemon and by tests that want to drive it in-process.
 *
 * Returns a promise that resolves when the daemon exits cleanly (SIGTERM
 * received and shutdown completes within the grace window).
 */
export async function runDaemon(spawn = nodeSpawn): Promise<void> {
  const state: DaemonState = {
    token: randomUUID(),
    startedAt: new Date().toISOString(),
    shuttingDown: false,
    reloadRequested: false,
    scheduleCount: 0,
    watchCount: 0,
  };

  const detector = new LoopDetector();
  // eslint-disable-next-line prefer-const
  let watcher!: Watcher;
  // eslint-disable-next-line prefer-const
  let refirer!: Refirer;
  // Status-snapshot writer — bound after the triad is constructed because
  // writeStatusSnapshot needs scheduler/watcher/refirer. The initial no-op
  // is replaced once the triad exists; any callback that fires before then
  // (impossible in practice — triad start is synchronous below) is a no-op.
  // eslint-disable-next-line prefer-const
  let writeStatus: () => void = () => undefined;
  watcher = new Watcher((name: string) =>
    fireWithSuppress(watcher, refirer, detector, name, "watch", writeStatus),
  );
  const scheduler = new Scheduler((name: string) =>
    fireWithSuppress(watcher, refirer, detector, name, "scheduled", writeStatus),
  );
  // Refirer drives plugin-initiated reschedules + post-failure retries. Fires
  // through the same watch-trigger pipeline (drains inbox, runs plugin).
  refirer = new Refirer((name: string) =>
    fireWithSuppress(watcher, refirer, detector, name, "watch", writeStatus),
  );
  writeStatus = (): void => {
    void writeStatusSnapshot(state, scheduler, watcher, detector);
  };
  // reconcile() loads config + grants fresh on every call, so SIGHUP
  // (`dither daemon reload`) is the supported way to pick up a library
  // change after `dither init --force`. We do NOT auto-reload on config
  // file change — see notes/qmd-library-edge-cases.md (#5).
  async function reconcile(): Promise<void> {
    const [plugins, libRoot] = await Promise.all([listPlugins(), resolveLibraryRoot()]);
    scheduler.set(scheduleEntriesOf(plugins));
    watcher.set(libRoot, watchEntriesOf(plugins));
    state.scheduleCount = scheduler.stats().count;
    state.watchCount = watcher.stats().count;
  }

  await writePidFile(state);
  // Truncate the events log on startup so subscribers don't replay
  // events from a previous (possibly-crashed) daemon process. Then emit
  // a fresh `daemon-started` so anyone watching sees the lifecycle.
  await truncateGlobal().catch((err) => {
    console.error(
      `[daemon] truncate events log failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  // Wipe any inflight-jobs files from a previous (possibly-crashed) daemon
  // so `dither status` doesn't report stale "current" jobs.
  await clearInflightJobs().catch((err) => {
    console.error(
      `[daemon] clear inflight jobs failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  await appendGlobal({ kind: "daemon-started", pid: process.pid }).catch((err) => {
    console.error(
      `[daemon] write daemon-started event failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  // Restore any inflight rows from a crashed prior run before reconciling —
  // ensures the first fire of each watch plugin sees items that were in
  // flight when the daemon went down.
  const recovered = await recoverOrphanInflight().catch(() => [] as string[]);
  if (recovered.length > 0) {
    console.error(`[daemon] recovered inflight for: ${recovered.join(", ")}`);
  }
  await reconcile();
  // Refire registry is independent of grants — load it once at startup and
  // again on SIGHUP. A new refire row written by a finishing run is picked
  // up by the next reconcile (or could trigger an inline refirer.set() —
  // deferred for now since plugins exit and the daemon reconciles often
  // enough in practice).
  await refirer.reload().catch((err) => {
    console.error(`[daemon] refire reload failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  // Drain kicks that arrived while the daemon was down. Same robustness
  // pattern as recoverOrphanInflight + refirer.reload.
  await scanKicks((name, payload) =>
    fireKick(watcher, refirer, detector, name, payload, writeStatus),
  ).catch((err) => {
    console.error(`[daemon] kick drain failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  await writeStatusSnapshot(state, scheduler, watcher, detector);

  // qmd state reconciliation runs off-thread in a `daemon reconcile`
  // child — embedding can take minutes (model download + per-chunk
  // embed) and must not block the daemon's event loop. We supervise the
  // child over stderr NDJSON and stay the sole writer of `jobs/` +
  // the global run-log. We don't await it; the events log is the
  // watcher's hand-off point. Concurrent triggers are coalesced below
  // (one child at a time, one queued follow-up).
  let inflight: Promise<void> | null = null;
  let queued = false;
  // The live reconcile child, if any. Phase 4 SIGTERMs it on shutdown.
  let reconcileChild: ChildProcess | null = null;
  // 500ms is well below human-perceivable latency for catch-up
  // indexing yet bounds wasted work if a plugin re-creates the
  // `needs-reindex` marker faster than reconcile can consume it.
  const REFIRE_MIN_MS = 500;
  let lastStart = 0;
  const fireQmdReconcile = (): void => {
    if (inflight) {
      // Mark a follow-up cycle so a SIGHUP / init handoff that arrives
      // mid-cycle isn't dropped.
      queued = true;
      return;
    }
    lastStart = Date.now();
    const sup = superviseReconcile(spawn);
    // Tracked so Phase 4's shutdown can SIGTERM an in-flight reconcile.
    reconcileChild = sup.child;
    inflight = sup.done
      .catch((err) => {
        console.error(
          `[daemon] qmd reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .then(() => {
        inflight = null;
        reconcileChild = null;
        if (!queued && !existsSync(needsReindexPath())) return;
        queued = false;
        const wait = Math.max(0, REFIRE_MIN_MS - (Date.now() - lastStart));
        if (wait > 0) setTimeout(fireQmdReconcile, wait).unref();
        else fireQmdReconcile();
      });
  };
  fireQmdReconcile();

  let resolveExit: () => void;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });

  function onTerm(): void {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    void shutdown();
  }

  async function shutdown(): Promise<void> {
    scheduler.stop();
    watcher.stop();
    refirer.stop();
    // Signal the in-flight reconcile child (if any) up front so it can wind
    // down its embed loop between iterations while plugin children drain. Its
    // SIGTERM handler sets a stop flag; the current native batch finishes,
    // then runJobWithLock's finally releases the theme lock — no stale
    // qmd-*.lock survives a clean stop. Backstop: a hard kill leaves a
    // PID-stamped lock the next acquirer reclaims via isPidAlive.
    const child = reconcileChild;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    // Single grace budget for BOTH plugin children and the reconcile child —
    // no second 30s wait stacked on top. Exit the loop once nothing is left
    // running and the reconcile child has closed (or grace elapses).
    const start = Date.now();
    while (Date.now() - start < SHUTDOWN_GRACE_MS) {
      const running = await readRunningPlugins();
      const reconcileLive = reconcileChild !== null && reconcileChild.exitCode === null;
      if (running.length === 0 && !reconcileLive) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await appendGlobal({ kind: "daemon-stopped", pid: process.pid }).catch(() => undefined);
    // Final status write — reflects the shutting-down state.
    await writeStatusSnapshot(state, scheduler, watcher, detector).catch(() => undefined);
    await removePidFile(state);
    resolveExit();
  }

  function onHup(): void {
    state.reloadRequested = true;
    void Promise.all([reconcile(), refirer.reload()])
      .then(() => writeStatus())
      .catch((err) => {
        console.error(`[daemon] reload failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    // SIGHUP is also the handoff signal from `dither init` / `dither
    // index update` — reconcile qmd state too.
    fireQmdReconcile();
  }

  function onUsr1(): void {
    // POSIX coalesces signals — every kick on disk gets processed per scan.
    void scanKicks((name, payload) =>
      fireKick(watcher, refirer, detector, name, payload, writeStatus),
    ).catch((err) => {
      console.error(`[daemon] kick scan failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);
  process.on("SIGHUP", onHup);
  process.on("SIGUSR1", onUsr1);

  await exited;

  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onTerm);
  process.off("SIGHUP", onHup);
  process.off("SIGUSR1", onUsr1);
}
