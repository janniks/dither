import { spawn } from "node:child_process";
import { open, readFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { pidFilePath, parsePidFile, daemonLogPath, resolveHome } from "./home";
import { readStatusSnapshot, type StatusSnapshot } from "./daemon";
import { acquire, isPidAlive, release } from "./locks";

/**
 * Cross-process control over the long-lived daemon. The CLI talks to a running
 * daemon entirely through the filesystem (PID file, status snapshot, log) plus
 * Unix signals — no socket. Sockets remain a future option (see specs/daemon.md
 * "Filesystem coordination + signals" decision).
 *
 * Liveness is the pid file + `kill(pid, 0)` + token match. The status snapshot
 * is event-driven (see daemon.ts) and may legitimately be old when the daemon
 * is idle; staleness does not imply death. `snapshot-mismatch` still signals
 * an on-disk artefact from a prior daemon process.
 */

/**
 * Why the daemon is considered not-running, or why its snapshot doesn't
 * match the live pid file. Surfaced by `dither daemon status` and
 * `dither status`.
 */
export type DaemonProbeReason =
  | "no-pidfile"
  | "bad-pidfile"
  | "dead-process"
  | "snapshot-mismatch";

export interface DaemonProbe {
  pid: number | null;
  reason: DaemonProbeReason | null;
  snapshot: StatusSnapshot | null;
}

async function readVerifiedSnapshot(): Promise<StatusSnapshot | null> {
  try {
    return await readStatusSnapshot();
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * One-shot diagnostic: walks the same checks as `readDaemonPid` but reports
 * why the daemon was rejected (if it was). The first failing gate wins.
 * Snapshot is opportunistic — a live daemon with no snapshot yet (just
 * started) still reports `reason: null`.
 */
export async function probeDaemon(): Promise<DaemonProbe> {
  if (!existsSync(pidFilePath())) {
    return { pid: null, reason: "no-pidfile", snapshot: null };
  }
  let raw: string;
  try {
    raw = await readFile(pidFilePath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { pid: null, reason: "no-pidfile", snapshot: null };
    }
    throw err;
  }
  const file = parsePidFile(raw);
  if (!file) return { pid: null, reason: "bad-pidfile", snapshot: null };
  if (!isPidAlive(file.pid)) {
    return { pid: file.pid, reason: "dead-process", snapshot: null };
  }
  // Liveness confirmed. The snapshot is opportunistic context.
  const snap = await readVerifiedSnapshot();
  if (snap && (snap.pid !== file.pid || snap.token !== file.token || snap.startedAt !== file.startedAt)) {
    return { pid: file.pid, reason: "snapshot-mismatch", snapshot: snap };
  }
  return { pid: file.pid, reason: null, snapshot: snap };
}

/**
 * Human-readable explanation for a probe reason. Empty string when the
 * daemon is running normally.
 */
export function formatProbeReason(reason: DaemonProbeReason | null): string {
  if (!reason) return "";
  if (reason === "no-pidfile") return "no pid file";
  if (reason === "bad-pidfile") return "corrupt pid file";
  if (reason === "dead-process") return "process not running";
  return "snapshot pid mismatch (stale state on disk)";
}

export async function readDaemonPid(): Promise<number | null> {
  const p = await probeDaemon();
  return p.reason === null ? p.pid : null;
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
    if (!isPidAlive(pid)) return { stopped: true, pid };
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
  /** Null when running; otherwise why we think it isn't. */
  reason: DaemonProbeReason | null;
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  const p = await probeDaemon();
  return {
    running: p.reason === null,
    pid: p.pid,
    home: resolveHome(),
    snapshot: p.snapshot ?? (await readVerifiedSnapshot()),
    reason: p.reason,
  };
}
