import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pidFilePath, statusSnapshotPath, locksDirPath, resolveHome } from "./home";
import { listRuns, type RunSummary } from "./journal";

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
    schedules: 0,
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
  };

  await writePidFile();
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
    // Phase 3: no in-flight plugin children owned by the daemon. Phases 4/5
    // will gate on running children with the SHUTDOWN_GRACE_MS budget.
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
    // Phase 3: reload is just a flag; phases 4+ will reread schedules/grants.
    state.reloadRequested = true;
  }

  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);
  process.on("SIGHUP", onHup);

  await exited;

  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onTerm);
  process.off("SIGHUP", onHup);
}
