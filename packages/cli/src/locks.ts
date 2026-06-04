import { existsSync, readFileSync, statSync } from "node:fs";
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveHome } from "./home";

/**
 * Lock files at `~/.dither/locks/<name>.lock`. Atomic via O_EXCL; the file
 * holds the PID of whoever's running. The single arbiter for "is X already
 * running" across processes — plugin runs, daemon-start, qmd-mutating work.
 *
 * Stale-lock recovery: if the lock holder's PID is no longer alive (process
 * crashed without releasing), the next acquirer takes over.
 *
 * Two API surfaces share one implementation:
 *   - `acquire(name)` / `release(handle)` — arbitrary named locks (plugin runs,
 *     daemon-start).
 *   - `acquireTheme(theme)` / `releaseTheme(handle)` / `status(theme)` — typed
 *     qmd-work locks. Themes name the kind of qmd-mutating work (download,
 *     index, embed) so callers can render uniform busy messages and so the
 *     daemon serialises against CLI commands at the SQLite layer. Lock-file
 *     names are prefixed with `qmd-` on disk.
 */

export type LockTheme = "download" | "index" | "embed";

export const LOCK_THEMES: readonly LockTheme[] = ["download", "index", "embed"] as const;

export interface LockHandle {
  readonly name: string;
  readonly path: string;
  readonly pid: number;
}

export interface LockEntry {
  readonly startedAt: Date;
  readonly pid: number;
}

function locksDir(): string {
  return join(resolveHome(), "locks");
}

function lockPath(name: string): string {
  return join(locksDir(), `${name}.lock`);
}

function themeName(theme: LockTheme): string {
  return `qmd-${theme}`;
}

/** Path of a theme's lock file — for tests and read-side renderers. */
export function themeLockPath(theme: LockTheme): string {
  return lockPath(themeName(theme));
}

/**
 * True when a lock name belongs to a plugin, false for reserved daemon
 * locks: the `qmd-*` theme locks held by the reconcile child and the
 * `daemon-start` spawn-serialisation lock. Locks live in one dir keyed
 * only by name, so readers that enumerate `locks/` (e.g. the status
 * snapshot's running-plugin scan) must filter these out — otherwise a
 * live reconcile child masquerades as a plugin named "qmd-embed".
 */
export function isPluginLock(name: string): boolean {
  return !name.startsWith("qmd-") && name !== "daemon-start";
}

/**
 * Liveness probe via signal 0. Returns false for finite-but-dead pids
 * (ESRCH), true for live pids and EPERM (process exists but we can't
 * signal it). Unexpected errno codes throw — they shouldn't happen on
 * any platform we run on, and silent return-false would mask them.
 */
export function isPidAlive(pid: number): boolean {
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

/**
 * Try to acquire the per-plugin lock. Returns a handle on success, `null` if
 * the plugin is already running. Stale locks (PID dead) are reclaimed
 * transparently.
 */
export async function acquire(name: string): Promise<LockHandle | null> {
  await mkdir(locksDir(), { recursive: true });
  const path = lockPath(name);
  const pid = process.pid;

  // Bounded retry loop: at most three attempts to handle the race where two
  // processes both detect a stale lock and one beats the other to unlink.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await open(path, "wx");
      try {
        await fh.writeFile(String(pid));
      } finally {
        await fh.close();
      }
      return { name, path, pid };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Lock exists. Check if its holder is still alive.
      let raw: string;
      try {
        raw = await readFile(path, "utf-8");
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") {
          // Holder unlinked between our open() and read(). Retry.
          continue;
        }
        throw readErr;
      }
      const holderPid = Number.parseInt(raw.trim(), 10);
      if (isPidAlive(holderPid)) {
        return null;
      }

      // Stale — try to unlink and retry the open.
      try {
        await unlink(path);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkErr;
      }
    }
  }
  return null;
}

/**
 * Read-only "is this lock held by a live process?" probe. Lets callers
 * pre-check a busy plugin without an acquire/release dance. Returns
 * false on missing files, malformed contents, or stale (dead) holders.
 */
export function isLockHeld(name: string): boolean {
  const path = lockPath(name);
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return isPidAlive(pid);
}

export async function release(handle: LockHandle): Promise<void> {
  try {
    const raw = await readFile(handle.path, "utf-8");
    const holderPid = Number.parseInt(raw.trim(), 10);
    if (holderPid !== handle.pid) {
      // Someone else now owns this lock — a stale-reclaim already happened.
      // Don't unlink; not our lock.
      return;
    }
    await unlink(handle.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Try to acquire the lock for a qmd theme. Returns a handle on success,
 * `null` if the theme is already locked by a live process. Stale locks
 * are reclaimed transparently. Non-blocking — callers either get the
 * lock or get back `null` immediately. Query `status(theme)` separately
 * if you want the holder's pid + startedAt for a busy-message renderer.
 */
export async function acquireTheme(theme: LockTheme): Promise<LockHandle | null> {
  return acquire(themeName(theme));
}

export async function releaseTheme(handle: LockHandle): Promise<void> {
  await release(handle);
}

/**
 * Read-only inspection of a theme lock. Returns `null` if no lock file
 * exists, or if the holder's PID is dead (stale entries are not
 * distinguished from absent — the next acquirer reclaims them). On a
 * live lock, returns `{startedAt, pid}` where startedAt is the file's
 * mtime (a proxy for acquire time, since the body holds only the PID).
 */
export function status(theme: LockTheme): LockEntry | null {
  const path = themeLockPath(theme);
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

/** Snapshot of every theme's lock state. Stale/missing entries are `null`. */
export function statusAll(): Record<LockTheme, LockEntry | null> {
  const out = {} as Record<LockTheme, LockEntry | null>;
  for (const theme of LOCK_THEMES) out[theme] = status(theme);
  return out;
}
