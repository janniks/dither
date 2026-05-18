import { existsSync, statSync } from "node:fs";
import { mkdir, open, rename, truncate, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { eventsLogPath } from "./home";

/**
 * Append-only JSONL event log carrying daemon lifecycle + per-job events.
 *
 * Producers (daemon only, by convention) call `appendEvent`. Subscribers
 * (`dither init` watching, `dither status`, future `dither watch`) call
 * `followEvents` and consume the async iterator, which yields parsed
 * events as they're appended.
 *
 * Implementation is pure Node — `fs.open` + `fs.fstat` polling + line
 * buffering across reads. No `fs.watch`: macOS coalesces / drops events
 * on rapid writes; the poll-based path is uniform across macOS, Linux,
 * Windows.
 *
 * Rotation: the daemon truncates the log on startup. During a long run,
 * if an append would push the file past `ROTATION_THRESHOLD_BYTES`, the
 * current file is `rename`d to `<path>.old` and a fresh empty file
 * starts the next append. Two files maximum, ever. Subscribers mid-read
 * on the rotated file get an EOF and would need to reopen the new file
 * — most subscribers (init's watch) live shorter than a rotation
 * window in practice.
 */

/** Maximum file size before rotation kicks in. Conservatively small. */
export const ROTATION_THRESHOLD_BYTES = 1_048_576; // 1 MiB

/** Poll interval for `followEvents` (`fstat` then optional `read`). */
export const FOLLOW_POLL_MS = 100;

/**
 * Discriminated event shape. New event kinds add a new `kind` literal —
 * unknown kinds are forward-compatible (subscribers ignore them).
 */
export interface BaseEvent {
  /** ISO timestamp at write time. */
  ts: string;
  kind: string;
  /** Free-form payload — varies per kind. */
  [key: string]: unknown;
}

/**
 * Atomically append one event. Each call opens, writes, closes — keeping
 * the file descriptor short-lived avoids subscriber visibility issues
 * with buffered OS-level writes. JSON is serialized + newline-terminated;
 * sub-`PIPE_BUF` writes (typical event ~150B) are atomic on POSIX.
 */
export async function appendEvent(event: Omit<BaseEvent, "ts"> & { ts?: string }): Promise<void> {
  const ts = event.ts ?? new Date().toISOString();
  const line = `${JSON.stringify({ ...event, ts })}\n`;
  const path = eventsLogPath();
  await mkdir(dirname(path), { recursive: true });

  // Pre-rotation check: if the current file would exceed the threshold
  // after this append, rotate first.
  const currentSize = existsSync(path) ? statSync(path).size : 0;
  if (currentSize + Buffer.byteLength(line, "utf-8") > ROTATION_THRESHOLD_BYTES) {
    await rotate(path);
  }

  const fh = await open(path, "a");
  try {
    await fh.write(line, null, "utf-8");
  } finally {
    await fh.close();
  }
}

/**
 * Truncate the events log to 0 bytes. Called by the daemon on startup so
 * the log doesn't carry events from a previous daemon process. Also
 * removes the `.old` rotation file if present — fresh start.
 */
export async function truncateEventsLog(): Promise<void> {
  const path = eventsLogPath();
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    await truncate(path, 0);
  }
  const oldPath = `${path}.old`;
  if (existsSync(oldPath)) {
    await unlink(oldPath);
  }
}

/**
 * Read the current events file end-to-end. Useful for `dither status`
 * which wants a snapshot of recent activity, not a live stream.
 *
 * `tailLines` caps how many lines back to return — useful when the file
 * has accumulated thousands of events. Pass `Infinity` for all.
 */
export async function readEvents(tailLines = Infinity): Promise<BaseEvent[]> {
  const path = eventsLogPath();
  if (!existsSync(path)) return [];
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return [];
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.length > 0);
    const slice = lines.slice(-Math.max(0, tailLines));
    return slice
      .map((l) => parseLine(l))
      .filter((e): e is BaseEvent => e !== null);
  } finally {
    await fh.close();
  }
}

/**
 * Follow the events log from the current end, yielding events as they
 * appear. Caller terminates by aborting the signal.
 *
 * The loop opens, seeks to current end via `fstat`, then polls `fstat`
 * every `FOLLOW_POLL_MS` and reads only the delta when size grows. Line
 * buffer carries across reads in case an append straddles a poll
 * boundary.
 *
 * On rotation (the file we hold shrinks because the daemon truncated, or
 * disappears because rename happened), the loop reopens at offset 0 and
 * continues. This preserves event delivery across daemon restart too.
 */
export async function* followEvents(
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent> {
  const path = eventsLogPath();
  await mkdir(dirname(path), { recursive: true });

  // Box `fh` inside a single-element holder so TS can't narrow it away
  // through control-flow analysis after `reopen()` mutates it from a
  // nested arrow. Without this, TS sees the initial `null` and the
  // closure-driven re-assignment, and pessimistically narrows to `never`
  // after the !== null check below.
  const holder: { fh: FileHandle | null } = { fh: null };
  let offset = 0;
  let lineBuffer = "";

  const reopen = async (startFromBeginning = false): Promise<void> => {
    if (holder.fh) {
      await holder.fh.close().catch(() => undefined);
      holder.fh = null;
    }
    if (!existsSync(path)) {
      offset = 0;
      lineBuffer = "";
      return;
    }
    holder.fh = await open(path, "r");
    if (startFromBeginning) {
      offset = 0;
      lineBuffer = "";
    } else {
      const st = await holder.fh.stat();
      offset = st.size;
    }
  };

  await reopen();

  try {
    while (!(signal?.aborted ?? false)) {
      const current = holder.fh;
      if (current === null) {
        await sleep(FOLLOW_POLL_MS, signal);
        await reopen();
        continue;
      }
      let st: { size: number };
      try {
        st = await current.stat();
      } catch {
        // FD invalidated by rotation — reopen at the new file's start.
        await reopen(true);
        continue;
      }
      if (st.size < offset) {
        // Truncation or rotation happened — reopen and read from start.
        await reopen(true);
        continue;
      }
      if (st.size > offset) {
        const toRead = st.size - offset;
        const buf = Buffer.alloc(toRead);
        await current.read(buf, 0, toRead, offset);
        offset = st.size;
        lineBuffer += buf.toString("utf-8");
        let nl: number;
        while ((nl = lineBuffer.indexOf("\n")) >= 0) {
          const line = lineBuffer.slice(0, nl);
          lineBuffer = lineBuffer.slice(nl + 1);
          const parsed = parseLine(line);
          if (parsed) yield parsed;
        }
      }
      await sleep(FOLLOW_POLL_MS, signal);
    }
  } finally {
    if (holder.fh !== null) await holder.fh.close().catch(() => undefined);
  }
}

async function rotate(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const oldPath = `${path}.old`;
  if (existsSync(oldPath)) await unlink(oldPath);
  await rename(path, oldPath);
}

function parseLine(line: string): BaseEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.ts !== "string" || typeof parsed.kind !== "string") return null;
    return parsed as BaseEvent;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exported for tests — confirms the rotated-file path the daemon writes to. */
export function eventsLogOldPath(): string {
  return `${eventsLogPath()}.old`;
}

/** Re-export so callers don't need a second import. */
export { eventsLogPath };
