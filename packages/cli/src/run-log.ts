import { existsSync, statSync, type Stats } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome, runEventsPath, runLogPath } from "./home";

/**
 * Run-log: one append-only JSONL stream with two scopes.
 *
 *   - **global** (`~/.dither/run-log.jsonl`) — daemon lifecycle, Job
 *     progress, Reconciler ticks. The daemon truncates on startup and
 *     rotates past 1 MB.
 *   - **run** (`~/.dither/history/<runId>/events.jsonl`) — per-Plugin
 *     execution events. One file per Run. Same 1 MB rotation policy.
 *
 * Implementation is pure Node — `fs.open` + `fs.fstat` polling + line
 * buffering across reads. No `fs.watch`: macOS coalesces / drops events
 * on rapid writes; the poll-based path is uniform across macOS, Linux,
 * Windows.
 *
 * Producers call `appendGlobal` / `appendRun` (or open a Run via
 * `openRun` which returns its own append). Subscribers call
 * `followGlobal` / `followRun` and consume the async iterator.
 *
 * Each Run directory also holds `manifest.json` (written when the Run
 * opens) and `result.json` (written when the Run closes). These are not
 * events — they're the Run's identity card and terminal state, read by
 * `listRuns` for `dither runs list`.
 */

export const ROTATION_THRESHOLD_BYTES = 1_048_576; // 1 MiB
export const FOLLOW_POLL_MS = 100;

/** Closed event-kind union — every kind any producer emits. */
export type EventKind =
  // global-scope (daemon lifecycle + jobs)
  | "daemon-started"
  | "daemon-stopped"
  | "reconcile-done"
  | "job-started"
  | "job-progress"
  | "job-done"
  | "job-failed"
  | "job-skipped"
  | "model-download-progress"
  // run-scope (plugin execution)
  | "progress"
  | "stderr"
  | "promoted"
  | "error"
  | "reschedule"
  | "reindex-deferred";

export interface LogEvent {
  ts: string;
  kind: EventKind;
  scope: "global" | "run";
  runId?: string;
  [key: string]: unknown;
}

export type GlobalEventInput =
  | (Omit<LogEvent, "ts" | "scope" | "runId"> & { ts?: string });

export type RunEventInput =
  | (Omit<LogEvent, "ts" | "scope" | "runId"> & { ts?: string });

export interface RunManifest {
  runId: string;
  plugin: string;
  trigger: string;
  startedAt: string;
}

export interface RunResultRecord {
  status: "ok" | "fail";
  finishedAt: string;
  exitCode?: number;
  error?: string;
  promoted?: string[];
  stderrTail?: string;
}

export interface RunSummary extends RunManifest {
  status: "ok" | "fail" | "running";
  finishedAt?: string;
  durationMs?: number;
  promotedCount?: number;
}

/** Append one event to the global scope. */
export async function appendGlobal(event: GlobalEventInput): Promise<void> {
  await appendAt(runLogPath(), { ...event, scope: "global" });
}

/** Append one event to a Run's scope. */
export async function appendRun(runId: string, event: RunEventInput): Promise<void> {
  await appendAt(runEventsPath(runId), { ...event, scope: "run", runId });
}

async function appendAt(path: string, event: Partial<LogEvent>): Promise<void> {
  const ts = (event.ts as string | undefined) ?? new Date().toISOString();
  const line = `${JSON.stringify({ ...event, ts })}\n`;
  await mkdir(dirname(path), { recursive: true });

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
 * Truncate the global Run-log. Daemon calls this on startup so the log
 * doesn't carry events from a previous daemon process. Also removes the
 * `.old` rotation file if present.
 */
export async function truncateGlobal(): Promise<void> {
  const path = runLogPath();
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) await truncate(path, 0);
  const oldPath = `${path}.old`;
  if (existsSync(oldPath)) await unlink(oldPath);
}

/** Read the entire global Run-log. `tailLines` caps the tail. */
export async function readGlobal(tailLines = Infinity): Promise<LogEvent[]> {
  return readFromPath(runLogPath(), tailLines);
}

/** Read the entire per-Run log for `runId`. */
export async function readRun(runId: string, tailLines = Infinity): Promise<LogEvent[]> {
  return readFromPath(runEventsPath(runId), tailLines);
}

async function readFromPath(path: string, tailLines: number): Promise<LogEvent[]> {
  if (!existsSync(path)) return [];
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return [];
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.length > 0);
    const slice = lines.slice(-Math.max(0, tailLines));
    return slice.map(parseLine).filter((e): e is LogEvent => e !== null);
  } finally {
    await fh.close();
  }
}

/** Follow the global Run-log from the current end. */
export function followGlobal(signal?: AbortSignal): AsyncGenerator<LogEvent> {
  return followAt(runLogPath(), signal);
}

/** Follow a Run's log from the current end. */
export function followRun(runId: string, signal?: AbortSignal): AsyncGenerator<LogEvent> {
  return followAt(runEventsPath(runId), signal);
}

async function* followAt(path: string, signal?: AbortSignal): AsyncGenerator<LogEvent> {
  await mkdir(dirname(path), { recursive: true });

  // Box `fh` inside a holder so TS can't narrow it away through closure
  // analysis after reopen() mutates it.
  const holder: { fh: FileHandle | null } = { fh: null };
  let offset = 0;
  let lineBuffer = "";

  const reopen = async (fromStart = false): Promise<void> => {
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
    if (fromStart) {
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
        // File didn't exist when the follow started. Read from byte 0
        // once it appears — otherwise we'd skip the events written
        // between iterator start and file creation.
        await reopen(true);
        continue;
      }
      let st: Pick<Stats, "dev" | "ino" | "size">;
      try {
        st = await current.stat();
      } catch {
        await reopen(true);
        continue;
      }
      if (st.size < offset) {
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
      const fresh = await stat(path).catch(() => null);
      if (!fresh || fresh.dev !== st.dev || fresh.ino !== st.ino) {
        await reopen(true);
        continue;
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

function parseLine(line: string): LogEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.ts !== "string" || typeof parsed.kind !== "string") return null;
    return parsed as LogEvent;
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

// -----------------------------------------------------------------------------
// Run lifecycle: manifest.json + events.jsonl + result.json under one dir
// -----------------------------------------------------------------------------

function historyDir(): string {
  return join(resolveHome(), "history");
}

function runDirOf(runId: string): string {
  return join(historyDir(), runId);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function generateRunId(plugin: string): string {
  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rand = randomBytes(2).toString("hex");
  const safe = plugin.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${stamp}-${safe}-${rand}`;
}

export interface RunHandle {
  readonly runId: string;
  readonly dir: string;
  append(event: RunEventInput): Promise<void>;
  close(result: RunResultRecord): Promise<void>;
}

/**
 * Open a new Run scope. Writes `manifest.json`, leaves `events.jsonl`
 * empty (created on first append), and returns a handle whose `append`
 * + `close` are tied to this runId. Closing writes `result.json`.
 */
export async function openRun(plugin: string, trigger: string): Promise<RunHandle> {
  const runId = generateRunId(plugin);
  const dir = runDirOf(runId);
  await mkdir(dir, { recursive: true });
  const manifest: RunManifest = {
    runId,
    plugin,
    trigger,
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return {
    runId,
    dir,
    async append(event) {
      await appendRun(runId, event);
    },
    async close(result) {
      await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
    },
  };
}

/** Newest-first listing of every Run on disk, summarised. */
export async function listRuns(limit = 20): Promise<RunSummary[]> {
  let dirents: string[];
  try {
    dirents = await readdir(historyDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const sorted = dirents.toSorted().toReversed();
  const out: RunSummary[] = [];
  for (const id of sorted) {
    if (out.length >= limit) break;
    const summary = await readSummary(id);
    if (summary) out.push(summary);
  }
  return out;
}

async function readSummary(runId: string): Promise<RunSummary | null> {
  const dir = runDirOf(runId);
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(join(dir, "manifest.json"), "utf-8");
  } catch {
    return null;
  }
  const manifest = JSON.parse(manifestRaw) as RunManifest;
  let result: RunResultRecord | null = null;
  try {
    const raw = await readFile(join(dir, "result.json"), "utf-8");
    result = JSON.parse(raw) as RunResultRecord;
  } catch {
    // result not yet written → run still in flight (or crashed mid-run)
  }

  const startedMs = Date.parse(manifest.startedAt);
  const finishedMs = result ? Date.parse(result.finishedAt) : NaN;
  return {
    ...manifest,
    status: result ? result.status : "running",
    finishedAt: result?.finishedAt,
    durationMs:
      Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? finishedMs - startedMs : undefined,
    promotedCount: result?.promoted?.length,
  };
}
