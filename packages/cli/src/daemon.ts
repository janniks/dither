import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pidFilePath, statusSnapshotPath, locksDirPath, resolveHome } from "./home";
import { libraryRoot as resolveLibraryRoot } from "./config";
import { appendGlobal, listRuns, truncateGlobal, type RunSummary } from "./run-log";
import { listPlugins } from "./plugin-list";
import { Scheduler, type ScheduleEntry } from "./scheduler";
import { Watcher, type WatchEntry } from "./watcher";
import { runPlugin } from "./plugin-run";
import { readFile as readFileAsync } from "node:fs/promises";
import { LoopDetector, type HaltRecord } from "./loop-detector";
import { inboxHasItems, recoverOrphanInflight } from "./inbox";
import { Refirer } from "./refirer";
import { readRefire } from "./refire";
import { qmdReconcile, clearInflightJobs, needsReindexPath } from "./daemon-jobs";

/**
 * Long-lived daemon process. In phase 3 the inner loop is a quiet heartbeat
 * that rewrites the status snapshot — phases 4 and 5 will populate it with
 * scheduler and watcher activity. The interesting work is the lifecycle:
 * PID file, signal handlers (SIGTERM graceful, SIGHUP no-op reload hook),
 * snapshot publishing.
 */

const HEARTBEAT_MS = 1_000;
const SHUTDOWN_GRACE_MS = 30_000;

export interface StatusSnapshot {
  pid: number;
  token: string;
  startedAt: string;
  lastTick: string;
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

interface GrantsManifest {
  schedule?: string;
  watch?: { collections: string[]; glob?: string };
}

interface GrantsBlob {
  manifest?: GrantsManifest;
}

async function loadScheduleEntries(): Promise<ScheduleEntry[]> {
  const plugins = await listPlugins();
  const entries: ScheduleEntry[] = [];
  for (const p of plugins) {
    if (p.schedule) entries.push({ name: p.name, schedule: p.schedule });
  }
  return entries;
}

async function loadWatchEntries(): Promise<WatchEntry[]> {
  const plugins = await listPlugins();
  const out: WatchEntry[] = [];
  for (const p of plugins) {
    const grantsPath = join(resolveHome(), "grants", `${p.name}.json`);
    try {
      const blob = JSON.parse(await readFileAsync(grantsPath, "utf-8")) as GrantsBlob;
      const watch = blob.manifest?.watch;
      if (watch && Array.isArray(watch.collections) && watch.collections.length > 0) {
        out.push({
          name: p.name,
          collections: watch.collections,
          ...(watch.glob ? { glob: watch.glob } : {}),
        });
      }
    } catch {
      // skip unreadable grants files
    }
  }
  return out;
}

async function fireWithSuppress(
  watcher: Watcher,
  refirer: Refirer,
  detector: LoopDetector,
  name: string,
  trigger: "scheduled" | "watch",
): Promise<void> {
  const source = `${trigger}:${name}`;
  if (detector.shouldHalt(source, name)) {
    detector.record(source, name, false);
    console.error(`[daemon] halting ${trigger} fire of '${name}' — loop threshold reached`);
    return;
  }
  detector.record(source, name, true);

  try {
    const result = await runPlugin({ name, trigger });
    for (const path of result.promoted) watcher.suppressOnce(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[daemon] ${trigger} fire of '${name}' failed: ${message}`);
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
    if (stillPending) void fireWithSuppress(watcher, refirer, detector, name, "watch");
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
    try {
      const raw = await readFile(join(locksDirPath(), filename), "utf-8");
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) out.push({ name, pid });
    } catch {
      // skip transient read failures
    }
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
    lastTick: new Date().toISOString(),
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
export async function runDaemon(): Promise<void> {
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
  watcher = new Watcher((name: string) =>
    fireWithSuppress(watcher, refirer, detector, name, "watch"),
  );
  const scheduler = new Scheduler((name: string) =>
    fireWithSuppress(watcher, refirer, detector, name, "scheduled"),
  );
  // Refirer drives plugin-initiated reschedules + post-failure retries. Fires
  // through the same watch-trigger pipeline (drains inbox, runs plugin).
  refirer = new Refirer((name: string) =>
    fireWithSuppress(watcher, refirer, detector, name, "watch"),
  );
  // reconcile() loads config + grants fresh on every call, so SIGHUP
  // (`dither daemon reload`) is the supported way to pick up a library
  // change after `dither init --force`. We do NOT auto-reload on config
  // file change — see notes/qmd-library-edge-cases.md (#5).
  async function reconcile(): Promise<void> {
    const [scheduleEntries, watchEntries, libRoot] = await Promise.all([
      loadScheduleEntries(),
      loadWatchEntries(),
      resolveLibraryRoot(),
    ]);
    scheduler.set(scheduleEntries);
    watcher.set(libRoot, watchEntries);
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
  await writeStatusSnapshot(state, scheduler, watcher, detector);

  // qmd state reconciliation runs in the background — it can take
  // minutes (model download + embedding). We don't await it; the
  // events log is the watcher's hand-off point. Multiple concurrent
  // calls are safe because the per-theme locks serialize the actual
  // work — and `qmdReconcile` itself is short on no-work paths.
  let qmdReconcileInFlight: Promise<void> | null = null;
  let qmdReconcileQueued = false;
  // Backoff for level-triggered re-fires: a plugin that re-creates
  // `needs-reindex` faster than reconcile can consume it would otherwise
  // spin the CPU. 500ms is well below human-perceivable latency for
  // catch-up indexing yet bounds wasted work.
  const LEVEL_TRIGGER_MIN_INTERVAL_MS = 500;
  let lastQmdReconcileStart = 0;
  const fireQmdReconcile = (): void => {
    if (qmdReconcileInFlight) {
      // A reconcile is running. Mark a follow-up cycle so a SIGHUP /
      // init handoff that arrives mid-cycle doesn't get dropped — it
      // will pick up any marker (incl. a fresh `needs-reindex`) the
      // in-flight cycle didn't see.
      qmdReconcileQueued = true;
      return;
    }
    lastQmdReconcileStart = Date.now();
    qmdReconcileInFlight = qmdReconcile()
      .catch((err) => {
        console.error(
          `[daemon] qmd reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .then(() => {
        qmdReconcileInFlight = null;
        // Level-triggered check: if a `needs-reindex` marker landed
        // during this cycle (e.g. plugin-run wrote it after promoting
        // files), pick it up without waiting for an external SIGHUP.
        if (!qmdReconcileQueued && !existsSync(needsReindexPath())) return;
        qmdReconcileQueued = false;
        const elapsed = Date.now() - lastQmdReconcileStart;
        const wait = Math.max(0, LEVEL_TRIGGER_MIN_INTERVAL_MS - elapsed);
        if (wait > 0) {
          setTimeout(fireQmdReconcile, wait).unref();
        } else {
          fireQmdReconcile();
        }
      });
  };
  fireQmdReconcile();

  let resolveExit: () => void;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });

  const tickHandle = setInterval(() => {
    void writeStatusSnapshot(state, scheduler, watcher, detector);
  }, HEARTBEAT_MS);

  function onTerm(): void {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    void shutdown();
  }

  async function shutdown(): Promise<void> {
    clearInterval(tickHandle);
    scheduler.stop();
    watcher.stop();
    refirer.stop();
    // Wait for in-flight plugin children (manual or scheduled) to finish.
    const start = Date.now();
    while (Date.now() - start < SHUTDOWN_GRACE_MS) {
      const running = await readRunningPlugins();
      if (running.length === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await appendGlobal({ kind: "daemon-stopped", pid: process.pid }).catch(() => undefined);
    await removePidFile(state);
    resolveExit();
  }

  function onHup(): void {
    state.reloadRequested = true;
    void Promise.all([reconcile(), refirer.reload()]).catch((err) => {
      console.error(`[daemon] reload failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // SIGHUP is also the handoff signal from `dither init` / `dither
    // index update` — reconcile qmd state too.
    fireQmdReconcile();
  }

  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);
  process.on("SIGHUP", onHup);

  await exited;

  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onTerm);
  process.off("SIGHUP", onHup);
}
