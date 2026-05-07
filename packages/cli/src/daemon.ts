import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pidFilePath, statusSnapshotPath, locksDirPath, resolveHome } from "./home";
import { libraryRoot as resolveLibraryRoot } from "./paths";
import { listRuns, type RunSummary } from "./journal";
import { listPlugins } from "./plugin-list";
import { Scheduler, type ScheduleEntry } from "./scheduler";
import { Watcher, type WatchEntry } from "./watcher";
import { runPlugin } from "./plugin-run";
import { readFile as readFileAsync } from "node:fs/promises";
import { LoopDetector, type HaltRecord } from "./loop-detector";

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
  detector: LoopDetector,
  name: string,
  trigger: "scheduled" | "watch",
  targets?: string[],
): Promise<void> {
  const source = `${trigger}:${name}`;
  if (detector.shouldHalt(source, name)) {
    detector.record(source, name, false);
    console.error(`[daemon] halting ${trigger} fire of '${name}' — loop threshold reached`);
    return;
  }
  detector.record(source, name, true);

  try {
    const result = await runPlugin({ name, trigger, targets });
    for (const path of result.promoted) watcher.suppressOnce(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[daemon] ${trigger} fire of '${name}' failed: ${message}`);
  }
}

async function writePidFile(): Promise<void> {
  await mkdir(resolveHome(), { recursive: true });
  await writeFile(pidFilePath(), String(process.pid));
}

async function removePidFile(): Promise<void> {
  try {
    await unlink(pidFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
    startedAt: new Date().toISOString(),
    shuttingDown: false,
    reloadRequested: false,
    scheduleCount: 0,
    watchCount: 0,
  };

  const detector = new LoopDetector();
  // eslint-disable-next-line prefer-const
  let watcher!: Watcher;
  watcher = new Watcher((name: string, targets: string[]) =>
    fireWithSuppress(watcher, detector, name, "watch", targets),
  );
  const scheduler = new Scheduler((name: string) =>
    fireWithSuppress(watcher, detector, name, "scheduled"),
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

  await writePidFile();
  await reconcile();
  await writeStatusSnapshot(state, scheduler, watcher, detector);

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
    // Wait for in-flight plugin children (manual or scheduled) to finish.
    const start = Date.now();
    while (Date.now() - start < SHUTDOWN_GRACE_MS) {
      const running = await readRunningPlugins();
      if (running.length === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await removePidFile();
    resolveExit();
  }

  function onHup(): void {
    state.reloadRequested = true;
    void reconcile().catch((err) => {
      console.error(`[daemon] reload failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);
  process.on("SIGHUP", onHup);

  await exited;

  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onTerm);
  process.off("SIGHUP", onHup);
}
