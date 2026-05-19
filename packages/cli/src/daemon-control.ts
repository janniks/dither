import { spawn } from "node:child_process";
import { open, readFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { pidFilePath, daemonLogPath, resolveHome } from "./home";
import { readStatusSnapshot, type StatusSnapshot } from "./daemon";
import { acquire, release } from "./locks";

/**
 * Cross-process control over the long-lived daemon. The CLI talks to a running
 * daemon entirely through the filesystem (PID file, status snapshot, log) plus
 * Unix signals — no socket. Sockets remain a future option (see specs/daemon.md
 * "Filesystem coordination + signals" decision).
 */

const STATUS_FRESH_MS = 15_000;

interface DaemonPidFile {
  pid: number;
  token: string;
  startedAt: string;
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

function parsePidFile(raw: string): DaemonPidFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid !== "number" || !Number.isFinite(obj.pid) || obj.pid <= 0) return null;
  if (typeof obj.token !== "string" || obj.token.length === 0) return null;
  if (typeof obj.startedAt !== "string" || obj.startedAt.length === 0) return null;
  return { pid: obj.pid, token: obj.token, startedAt: obj.startedAt };
}

function matchesPidFile(snapshot: StatusSnapshot | null, pid: DaemonPidFile): boolean {
  if (!snapshot) return false;
  if (snapshot.pid !== pid.pid || snapshot.token !== pid.token) return false;
  if (snapshot.startedAt !== pid.startedAt) return false;
  const lastTick = Date.parse(snapshot.lastTick);
  return Number.isFinite(lastTick) && Date.now() - lastTick <= STATUS_FRESH_MS;
}

async function readVerifiedSnapshot(): Promise<StatusSnapshot | null> {
  try {
    return await readStatusSnapshot();
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function readDaemonPid(): Promise<number | null> {
  if (!existsSync(pidFilePath())) return null;
  try {
    const raw = await readFile(pidFilePath(), "utf-8");
    const pid = parsePidFile(raw);
    if (!pid || !isAlive(pid.pid)) return null;
    return matchesPidFile(await readVerifiedSnapshot(), pid) ? pid.pid : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface StartResult {
  pid: number;
  alreadyRunning: boolean;
}

async function waitForDaemonPid(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readDaemonPid();
    if (pid) return pid;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/**
 * Spawn the daemon detached. If a live daemon is already running, returns
 * `{ alreadyRunning: true }` without spawning a second one.
 *
 * The detached child reuses this binary's argv[0] (node) and argv[1] (the
 * cli entrypoint), invoking the hidden `daemon run` subcommand which runs
 * the main loop until SIGTERM.
 */
export async function startDaemon(): Promise<StartResult> {
  const existing = await readDaemonPid();
  if (existing) return { pid: existing, alreadyRunning: true };

  const lock = await acquire("daemon-start");
  if (!lock) {
    const pid = await waitForDaemonPid(5_000);
    if (pid) return { pid, alreadyRunning: true };
    throw new Error("Timed out waiting for concurrent daemon start");
  }

  try {
    const running = await readDaemonPid();
    if (running) return { pid: running, alreadyRunning: true };

    // Remove any stale or unverifiable PID file.
    try {
      await unlink(pidFilePath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    await mkdir(dirname(daemonLogPath()), { recursive: true });
    const logFile = await open(daemonLogPath(), "a");
    const logFd = logFile.fd;

    const exec = process.execPath;
    const entry = process.argv[1];
    if (!entry) throw new Error("Cannot determine CLI entrypoint to spawn daemon");

    const child = spawn(exec, [entry, "daemon", "run"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, DITHER_DAEMON: "1" },
    });
    child.unref();

    // Don't close the log fd until the child has duped it — but spawn() returns
    // after the child inherits it, so closing here is safe.
    await logFile.close();

    if (!child.pid) throw new Error("Failed to spawn daemon (no pid)");

    const pid = await waitForDaemonPid(5_000);
    if (pid) return { pid, alreadyRunning: false };
    throw new Error(`Daemon did not write ${pidFilePath()} within 5s`);
  } finally {
    await release(lock);
  }
}

export interface StopResult {
  stopped: boolean;
  pid: number | null;
}

export async function stopDaemon(timeoutMs = 35_000): Promise<StopResult> {
  const pid = await readDaemonPid();
  if (!pid) return { stopped: false, pid: null };

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return { stopped: false, pid };
    }
    throw err;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { stopped: true, pid };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { stopped: false, pid };
}

export async function reloadDaemon(): Promise<boolean> {
  const pid = await readDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, "SIGHUP");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  home: string;
  snapshot: StatusSnapshot | null;
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  const pid = await readDaemonPid();
  const snapshot = await readStatusSnapshot();
  return {
    running: pid !== null,
    pid,
    home: resolveHome(),
    snapshot,
  };
}
