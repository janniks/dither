import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveHome } from "./home";

/**
 * Per-plugin lock files at `~/.dither/locks/<name>.lock`. Atomic via O_EXCL;
 * the lock file holds the PID of whoever's running. The single arbiter for
 * "is plugin X already running" between scheduled, watch, and manual fires.
 *
 * Stale-lock recovery: if the lock holder's PID is no longer alive (process
 * crashed without releasing), the next acquirer takes over.
 */

export interface LockHandle {
  readonly name: string;
  readonly path: string;
  readonly pid: number;
}

function locksDir(): string {
  return join(resolveHome(), "locks");
}

function lockPath(name: string): string {
  return join(locksDir(), `${name}.lock`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but we can't signal it — treat as alive.
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
