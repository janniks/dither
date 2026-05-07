import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pidFilePath, statusSnapshotPath, locksDirPath, resolveHome } from "./home";
import { listRuns, type RunSummary } from "./journal";
import { listPlugins } from "./plugin-list";
import { Scheduler, type ScheduleEntry } from "./scheduler";
import { runPlugin } from "./plugin-run";

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
}

async function loadScheduleEntries(): Promise<ScheduleEntry[]> {
  const plugins = await listPlugins();
  const entries: ScheduleEntry[] = [];
  for (const p of plugins) {
    if (p.schedule) entries.push({ name: p.name, schedule: p.schedule });
  }
  return entries;
}

async function fireScheduled(name: string): Promise<void> {
  try {
    await runPlugin({ name, trigger: "scheduled" });
  } catch (err) {
    // Lock conflicts (already running) and plugin failures both arrive here.
    // The journal records the failure; just log a single line.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[daemon] scheduled fire of '${name}' failed: ${message}`);
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

async function writeStatusSnapshot(state: DaemonState): Promise<void> {
  const running = await readRunningPlugins();
  const recentRuns = await listRuns(5).catch(() => []);
  const snapshot: StatusSnapshot = {
    pid: process.pid,
    startedAt: state.startedAt,
    lastTick: new Date().toISOString(),
    version: "0.0.1",
    schedules: state.scheduleCount,
    watches: 0,
    running,
    recentRuns,
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
  };

  const scheduler = new Scheduler(fireScheduled);
  async function reconcile(): Promise<void> {
    const entries = await loadScheduleEntries();
    scheduler.set(entries);
    state.scheduleCount = scheduler.stats().count;
  }

  await writePidFile();
  await reconcile();
  await writeStatusSnapshot(state);

  let resolveExit: () => void;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });

  const tickHandle = setInterval(() => {
    void writeStatusSnapshot(state);
  }, HEARTBEAT_MS);

  function onTerm(): void {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    void shutdown();
  }

  async function shutdown(): Promise<void> {
    clearInterval(tickHandle);
    scheduler.stop();
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
