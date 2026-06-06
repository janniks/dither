import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, unlink, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { pidFilePath, statusSnapshotPath, locksDirPath, daemonLogPath, resolveHome } from "./home";
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
import { kickSource, type KickPayload } from "./kicks";
import type { Outcome, Source, Emit } from "./queue";
import { acquire as acquireLock, release as releaseLock, isPluginLock, isPidAlive } from "./locks";
import { clearInflightJobs } from "./daemon-jobs";
import { superviseReconcile } from "./reconcile-supervisor";
import { needsReindexPath } from "./markers";
import { isStale, stampString, readBuildInfo } from "./build-stamp";
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * Long-lived daemon process. The status snapshot is event-driven — written
 * at startup, SIGHUP reload, run start/end, loop-detector halt, and shutdown.
 * No periodic heartbeat; liveness is the pid file + `kill(pid, 0)` + token
 * match. `lastUpdated` on the snapshot tells the user how fresh it is.
 */

const SHUTDOWN_GRACE_MS = 30_000;

// Drain budget for a version hand-off — separate, longer knob than the
// interactive `SHUTDOWN_GRACE_MS` (Ctrl-C / `daemon stop`). A restart waits
// up to this long for in-flight plugin children to finish before spawning the
// successor; the reconcile child is SIGTERM'd immediately (durable in SQLite).
const RESTART_DRAIN_MS = 300_000;

// How long the old daemon polls the PID file for the successor's distinct
// identity before giving up and rolling back (P4). Overridable for tests via
// `setHandoffConfirmMs` so rollback/flap tests don't wait the full 30s.
const HANDOFF_CONFIRM_DEFAULT_MS = 30_000;
let handoffConfirmMs = HANDOFF_CONFIRM_DEFAULT_MS;

/** Test-only: shrink (or restore) the confirm-timeout so rollback is fast. */
export function setHandoffConfirmMs(ms: number): void {
  handoffConfirmMs = ms;
}

// Consecutive failed hand-offs (rollbacks) before the daemon gives up on
// auto-restart and stays on old code until a human intervenes.
const FLAP_THRESHOLD = 3;

export interface StatusSnapshot {
  pid: number;
  token: string;
  startedAt: string;
  lastUpdated: string;
  // SemVer stamp of the running daemon's baked build (`stampString`).
  version: string;
  // True once auto-restart has flapped past FLAP_THRESHOLD — the daemon gave up
  // handing off and stays on old code (a human must `dither daemon restart`).
  restartDisabled: boolean;
  // Consecutive failed hand-offs so far (0 while healthy).
  restartFails: number;
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

export interface DaemonState {
  token: string;
  startedAt: string;
  shuttingDown: boolean;
  reloadRequested: boolean;
  // Set true synchronously at the very start of a version hand-off — both a
  // re-entrancy guard (a second trigger is a no-op) and a "stop dispatching"
  // gate (the choke point leaves the triggering kick for the successor).
  handingOff: boolean;
  // Consecutive failed hand-offs (rollbacks). Resets implicitly on a successful
  // hand-off — that process exits and the successor starts fresh at 0.
  restartFails: number;
  // Latched once `restartFails` hits FLAP_THRESHOLD: the daemon stops attempting
  // auto-restarts and stays on old code until a human restarts it.
  restartDisabled: boolean;
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

/**
 * Single choke point for staleness on every external IPC entry (SIGUSR1 kick,
 * SIGHUP reload). If the build on disk differs from the one we're running, log
 * a `stale-detected` event carrying both stamps. Returns whether stale so the
 * caller can branch.
 *
 * P2: detect + log only — the normal handling (kick drain / reconcile) still
 * proceeds. P3 SEAM: when `isStale()`, this is where the hand-off begins —
 * set a `handingOff` flag, stop sources, and start the drain/spawn instead of
 * (or before) returning to the normal handler. Do NOT restart here yet.
 */
export async function checkStale(dir?: string): Promise<boolean> {
  if (!(await isStale(dir))) return false;
  await appendGlobal({
    kind: "stale-detected",
    from: stampString(),
    to: stampString((await readBuildInfo(dir)) ?? undefined),
  }).catch(() => undefined);
  return true;
}

interface KickContext {
  runId: string;
  overrides?: KickPayload["overrides"];
}

// Exported for tests only — the daemon drives these through `runDaemon`'s
// closures. Tests assert the hand-off gate (handingOff → no run) and the
// kick-not-consumed mapping (gated kick → "retry" → restore).
export async function fireWithSuppress(
  state: DaemonState,
  watcher: Watcher,
  refirer: Refirer,
  detector: LoopDetector,
  name: string,
  trigger: "scheduled" | "watch" | "manual",
  notify: () => void,
  kick?: KickContext,
): Promise<boolean> {
  // Hand-off gate: once handing off we stop dispatching new runs. The trigger
  // that arrives mid-hand-off must NOT be consumed — for a kick this surfaces
  // as `false` (→ "retry" → restore → successor drains it). We return BEFORE
  // acquiring the lock or running anything.
  if (state.handingOff) return false;
  const source = `${trigger}:${name}`;
  if (detector.shouldHalt(source, name)) {
    detector.record(source, name, false);
    console.error(`[daemon] halting ${trigger} fire of '${name}' — loop threshold reached`);
    notify();
    return false;
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
    return true;
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
    if (stillPending) void fireWithSuppress(state, watcher, refirer, detector, name, "watch", notify);
  }
  return true;
}

export async function fireKick(
  state: DaemonState,
  watcher: Watcher,
  refirer: Refirer,
  detector: LoopDetector,
  name: string,
  payload: KickPayload,
  notify: () => void,
): Promise<Outcome> {
  // `fireWithSuppress` swallows its own run errors (logs + returns true), so a
  // claimed kick acks once attempted. The durability that matters is
  // crash-before-attempt: the kick stays pending (or restores from inflight
  // on boot recover) and re-fires next drain. The one case that returns
  // `false` is a hand-off in progress — the run was NOT started, so we report
  // `"retry"` and the Queue restores the kick to pending for the successor.
  const ran = await fireWithSuppress(state, watcher, refirer, detector, name, "manual", notify, {
    runId: payload.runId,
    ...(payload.overrides ? { overrides: payload.overrides } : {}),
  });
  return ran ? "done" : "retry";
}

/**
 * Boot / SIGHUP, expressed once: `start` each source's live producer, then
 * `recover` its owed work from durable state. Per-source guarded so one
 * source's recovery failure can't sink the rest. This is the single uniform
 * path the spec asks for — kicks, watcher, scheduler, refirer all flow through
 * it instead of five bespoke call sites.
 */
async function recoverAll(
  sources: ReadonlyArray<{ name: string; source: Source; emit: Emit }>,
): Promise<void> {
  for (const { name, source, emit } of sources) {
    await Promise.resolve(source.start()).catch((err) => {
      console.error(`[daemon] ${name} start failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    await Promise.resolve(source.recover(emit)).catch((err) => {
      console.error(`[daemon] ${name} recover failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
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

/**
 * Read the on-disk PID file's `{pid, token}` (the identity of whoever owns the
 * daemon right now). ENOENT / malformed → null. Used by the hand-off to confirm
 * the successor has taken ownership (a DIFFERENT identity than ours).
 */
async function readPidIdentity(): Promise<{ pid: number; token: string } | null> {
  let raw: string;
  try {
    raw = await readFile(pidFilePath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: { pid?: unknown; token?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
  return { pid: parsed.pid, token: parsed.token };
}

export async function readRunningPlugins(): Promise<RunningPlugin[]> {
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
    // Skip reserved daemon locks (qmd-* themes held by the reconcile child,
    // daemon-start) — they share locks/ but aren't plugins.
    if (!isPluginLock(name)) continue;
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
    version: stampString(),
    restartDisabled: state.restartDisabled,
    restartFails: state.restartFails,
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
    handingOff: false,
    restartFails: 0,
    restartDisabled: false,
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
  const fireWatch = (name: string): void => {
    void fireWithSuppress(state, watcher, refirer, detector, name, "watch", writeStatus);
  };
  const fireScheduled = (name: string): void => {
    void fireWithSuppress(state, watcher, refirer, detector, name, "scheduled", writeStatus);
  };
  watcher = new Watcher(fireWatch);
  const scheduler = new Scheduler(fireScheduled);
  // Refirer drives plugin-initiated reschedules + post-failure retries. Fires
  // through the same watch-trigger pipeline (drains inbox, runs plugin).
  refirer = new Refirer(fireWatch);
  writeStatus = (): void => {
    void writeStatusSnapshot(state, scheduler, watcher, detector);
  };
  // Kicks: the first fire source migrated onto the durable `Queue`. `start`
  // wires SIGUSR1 → drain; `recover` re-queues an inflight kick left by a
  // crashed daemon then drains everything pending on disk.
  const kicks = kickSource((name, payload) =>
    fireKick(state, watcher, refirer, detector, name, payload, writeStatus),
  );
  // Every fire source, each paired with the `emit` its recover nudges. Boot
  // and SIGHUP both reduce to "recover all of these" (see recoverAll). Kicks
  // and the refirer ignore `emit` — they fire through their own closures — so
  // they get a no-op; the watcher/scheduler emit re-fires through the choke
  // point. Order is irrelevant: sources are independent.
  const noop: Emit = () => undefined;
  const sources: Array<{ name: string; source: Source; emit: Emit }> = [
    { name: "kick", source: kicks, emit: noop },
    { name: "watch", source: watcher, emit: fireWatch },
    { name: "schedule", source: scheduler, emit: fireScheduled },
    { name: "refire", source: refirer, emit: noop },
  ];
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

  // Bring every source up: `reconcile()` re-`set()`s the scheduler/watcher
  // entries (their `stop()` cleared them), then `recoverAll` `start`s each live
  // producer and `recover`s its owed work from durable state. Called once on
  // boot and again on hand-off rollback — the same wiring, so a rollback resumes
  // exactly as a fresh boot would (the restored kick drains here on old code).
  async function armSources(): Promise<void> {
    await reconcile();
    await recoverAll(sources);
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
  // One uniform boot path: re-derive every source's owed work from durable
  // state. `reconcile()` first because the watcher/scheduler recover needs the
  // active entries it `set()`s. The inbox is not a source — it's the Queue's
  // own recovery — so it leads, restoring inflight rows so the first watch fire
  // sees items in flight when the daemon went down. Then each source `start`s
  // its live producer and `recover`s its missed work (kick drain, watch
  // watermark scan, schedule anacron catch-up, refire re-arm), uniformly.
  const recovered = await recoverOrphanInflight().catch(() => [] as string[]);
  if (recovered.length > 0) {
    console.error(`[daemon] recovered inflight for: ${recovered.join(", ")}`);
  }
  await armSources();
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

  /**
   * Version hand-off: quiet → drain → spawn successor → confirm → exit. Built
   * from the on-disk bundle (re-exec'ing `execPath argv1 daemon run`), so the
   * successor runs the fresh code. The durable queue carries any in-flight
   * trigger across; the successor's boot recover drains it.
   */
  async function handOff(): Promise<void> {
    // Re-entrancy + "stop dispatching" gate. Set synchronously before any
    // await, so a second trigger (or a fire mid-hand-off) is a no-op and the
    // choke point leaves the kick for the successor. Once `restartDisabled`
    // (flapped past FLAP_THRESHOLD), every trigger is a no-op — the daemon stays
    // on old code until a human restarts it.
    if (state.handingOff || state.shuttingDown || state.restartDisabled) return;
    state.handingOff = true;

    const to = stampString((await readBuildInfo()) ?? undefined);
    await appendGlobal({ kind: "daemon-restarting", from: stampString(), to }).catch(() => undefined);

    // quiet: stop every live producer. handingOff already gates the choke
    // point for any signal still in flight.
    scheduler.stop();
    watcher.stop();
    refirer.stop();
    kicks.stop();

    // drain: SIGTERM the reconcile child immediately (durable in SQLite,
    // re-reconciled via marker), then wait for plugin children to finish
    // within RESTART_DRAIN_MS — its own, longer knob.
    const child = reconcileChild;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    const drainStart = Date.now();
    while (Date.now() - drainStart < RESTART_DRAIN_MS) {
      const running = await readRunningPlugins();
      const reconcileLive = reconcileChild !== null && reconcileChild.exitCode === null;
      if (running.length === 0 && !reconcileLive) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    // spawn successor: detached re-exec of the on-disk bundle (fresh code).
    // Mirrors daemon-control's spawn block; uses the injectable `spawn` so
    // tests can simulate a successor.
    const entry = process.argv[1];
    if (!entry) {
      await appendGlobal({ kind: "daemon-restart-failed", reason: "no-entrypoint" }).catch(() => undefined);
      return rollback("no-entrypoint");
    }
    await mkdir(dirname(daemonLogPath()), { recursive: true });
    const logFile = await open(daemonLogPath(), "a");
    const successor = spawn(process.execPath, [entry, "daemon", "run"], {
      detached: true,
      stdio: ["ignore", logFile.fd, logFile.fd],
      env: { ...process.env, DITHER_DAEMON: "1" },
    });
    successor.unref();
    await logFile.close();

    // confirm: poll the PID file until it shows a DIFFERENT identity than our
    // own (the successor wrote its own {pid, token}) AND that pid is alive. We
    // can't use waitForDaemonPid — it would return our own still-live pid.
    const confirmStart = Date.now();
    let confirmed = false;
    while (Date.now() - confirmStart < handoffConfirmMs) {
      const id = await readPidIdentity();
      if (id && (id.pid !== process.pid || id.token !== state.token) && isPidAlive(id.pid)) {
        confirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!confirmed) {
      await appendGlobal({ kind: "daemon-restart-failed", reason: "confirm-timeout" }).catch(() => undefined);
      return rollback("confirm-timeout");
    }
    // Success: this process now exits and hands the PID file to the successor.
    // Reset the flap counter for correctness (moot — we're about to exit).
    state.restartFails = 0;
    return finishHandoff();
  }

  // Graceful exit tail of a SUCCESSFUL hand-off. removePidFile is token-guarded,
  // so it never clobbers the successor's PID file.
  async function finishHandoff(): Promise<void> {
    state.shuttingDown = true;
    await appendGlobal({ kind: "daemon-restarted", pid: process.pid }).catch(() => undefined);
    await removePidFile(state);
    resolveExit();
  }

  // Rollback: the successor failed to come up (spawn/argv missing or confirm
  // timed out). Stay alive on old code rather than exit into a dead successor.
  // Bump the flap counter; past FLAP_THRESHOLD, latch `restartDisabled` so
  // further triggers no-op (a human must intervene). Clear `handingOff` and
  // re-arm sources via the exact boot wiring — the restored kick drains here.
  async function rollback(reason: string): Promise<void> {
    state.restartFails += 1;
    await appendGlobal({ kind: "daemon-restart-rolledback", reason }).catch(() => undefined);
    if (state.restartFails >= FLAP_THRESHOLD && !state.restartDisabled) {
      state.restartDisabled = true;
      await appendGlobal({ kind: "daemon-restart-disabled", fails: state.restartFails }).catch(() => undefined);
    }
    state.handingOff = false;
    await armSources();
    writeStatus();
  }

  function onHup(): void {
    // P3: on stale, hand off instead of reconciling on stale code. checkStale
    // already logs `stale-detected`; handOff logs `daemon-restarting`.
    void checkStale().then((stale) => {
      if (stale) return void handOff();
      state.reloadRequested = true;
      void Promise.all([reconcile(), refirer.reload()])
        .then(() => writeStatus())
        .catch((err) => {
          console.error(`[daemon] reload failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      // SIGHUP is also the handoff signal from `dither init` / `dither
      // index update` — reconcile qmd state too.
      fireQmdReconcile();
    });
  }

  // P3: on stale, branch into the hand-off. The kick Source's own SIGUSR1
  // handler (wired by recoverAll's `start`) still drains in parallel — but
  // `handingOff` gates the choke point, so the triggering kick is left for the
  // successor (it returns "retry" → restore → pending).
  const onUsr1 = (): void => {
    void checkStale().then((stale) => {
      if (stale) void handOff();
    });
  };

  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);
  process.on("SIGHUP", onHup);
  process.on("SIGUSR1", onUsr1);
  // The kick Source's SIGUSR1 handler was already wired by recoverAll's
  // `start` above (POSIX coalesces signals; every kick on disk gets processed
  // per drain). This second listener only checks staleness — it does not touch
  // the drain.

  await exited;

  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onTerm);
  process.off("SIGHUP", onHup);
  process.off("SIGUSR1", onUsr1);
  kicks.stop();
}
