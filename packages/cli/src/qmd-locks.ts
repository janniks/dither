import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { acquire, release, type LockHandle } from "./locks";
import { resolveHome } from "./home";

/**
 * Per-theme lock orchestration for qmd-mutating work.
 *
 * Three lock files at `~/.dither/locks/qmd-{download,index,embed}.lock`
 * coordinate the daemon's job runner with any CLI command that would
 * write to qmd state (`dither index update`, plugin post-promote
 * reindex, second `dither init`, etc.).
 *
 * The lock file *name* encodes the theme — busy messages can report
 * what's happening with just `existsSync` + `fstat(mtime)` for elapsed,
 * no body schema to parse.
 *
 * Reuses `locks.ts` primitives: atomic O_EXCL acquire, stale-PID
 * reclaim, PID-only body. Non-blocking acquire only — callers either
 * get the lock or get back a `{busy}` descriptor immediately. No retry
 * loops; no waiting. Read-side commands (`dither search`, `dither get`)
 * never touch any lock.
 */

export type QmdLockTheme = "download" | "index" | "embed";

export const QMD_LOCK_THEMES: readonly QmdLockTheme[] = ["download", "index", "embed"] as const;

export interface QmdLockBusy {
  busy: true;
  theme: QmdLockTheme;
  /** Acquired-at time, derived from the lock file's mtime. */
  startedAt: Date;
}

export interface QmdLockHandle {
  busy: false;
  theme: QmdLockTheme;
  handle: LockHandle;
}

export interface QmdLockEntry {
  startedAt: Date;
  pid: number;
}

export type QmdLockStatus = Partial<Record<QmdLockTheme, QmdLockEntry>>;

function lockName(theme: QmdLockTheme): string {
  return `qmd-${theme}`;
}

function lockPath(theme: QmdLockTheme): string {
  return join(resolveHome(), "locks", `${lockName(theme)}.lock`);
}

/**
 * Attempt to take the lock for `theme`. On success, returns a handle the
 * caller must pass to `releaseQmdLock` when done (typically in a
 * `finally`). On contention, returns a `QmdLockBusy` descriptor naming
 * the theme and when it was acquired so the caller can render a uniform
 * busy message.
 */
export async function tryAcquireQmdLock(theme: QmdLockTheme): Promise<QmdLockHandle | QmdLockBusy> {
  const handle = await acquire(lockName(theme));
  if (handle === null) {
    return {
      busy: true,
      theme,
      startedAt: readLockMtime(theme) ?? new Date(),
    };
  }
  return { busy: false, theme, handle };
}

/**
 * Release a previously-acquired qmd lock. Idempotent: safe to call
 * twice; safe to call on a handle whose underlying lock was reclaimed
 * by another process.
 */
export async function releaseQmdLock(handle: QmdLockHandle): Promise<void> {
  await release(handle.handle);
}

/**
 * Read-only snapshot of which themes are currently locked. Used by
 * `dither status` and busy-message renderers. Each entry is the lock's
 * PID + mtime; no parsing of body content beyond the PID.
 *
 * Stale PIDs (locks held by dead processes) are reported here as
 * `undefined` — the next `tryAcquireQmdLock` for the same theme will
 * reclaim them via `locks.ts`'s stale-PID logic.
 */
export function qmdLockStatus(): QmdLockStatus {
  const status: QmdLockStatus = {};
  for (const theme of QMD_LOCK_THEMES) {
    const info = readLockInfo(theme);
    if (info) status[theme] = info;
  }
  return status;
}

function readLockMtime(theme: QmdLockTheme): Date | null {
  const path = lockPath(theme);
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtime;
  } catch {
    return null;
  }
}

function readLockInfo(theme: QmdLockTheme): { startedAt: Date; pid: number } | null {
  const path = lockPath(theme);
  if (!existsSync(path)) return null;
  try {
    const st = statSync(path);
    const raw = readFileSync(path, "utf-8");
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!isPidAlive(pid)) return null;
    return { startedAt: st.mtime, pid };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists, we just can't signal
    return false;
  }
}

/** Path of a specific theme's lock — useful in tests + status renderers. */
export function qmdLockPath(theme: QmdLockTheme): string {
  return lockPath(theme);
}
