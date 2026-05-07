import { open, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./home";

/**
 * Run-history journal. Every plugin run — manual today, scheduled and watch
 * later — produces a directory at `~/.dither/history/<runId>/`:
 *
 *   manifest.json   {runId, plugin, trigger, startedAt}      written on open
 *   events.ndjson   one JSON object per line, appended live  events stream
 *   result.json     {status, finishedAt, exitCode?, ...}     written on close
 *
 * The journal is the source of truth for `dither runs list` and `runs tail`.
 */

export type EventType = "progress" | "stderr" | "promoted" | "error";

export interface JournalEvent {
  type: EventType;
  at: string;
  [k: string]: unknown;
}

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

export function historyDir(): string {
  return join(resolveHome(), "history");
}

function runDirOf(runId: string): string {
  return join(historyDir(), runId);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function generateRunId(plugin: string): string {
  // Sortable + readable: 20260507T084600-<plugin>-<rand4>.
  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rand = randomBytes(2).toString("hex");
  // Plugin name may contain '/' — flatten.
  const safe = plugin.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${stamp}-${safe}-${rand}`;
}

export class RunJournal {
  private fh: FileHandle | null = null;
  readonly dir: string;

  constructor(
    readonly runId: string,
    readonly plugin: string,
    readonly trigger: string,
    readonly startedAt: string,
  ) {
    this.dir = runDirOf(runId);
  }

  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const manifest: RunManifest = {
      runId: this.runId,
      plugin: this.plugin,
      trigger: this.trigger,
      startedAt: this.startedAt,
    };
    await writeFile(join(this.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    this.fh = await open(join(this.dir, "events.ndjson"), "a");
  }

  async append(type: EventType, payload: Record<string, unknown> = {}): Promise<void> {
    if (!this.fh) return;
    const event: JournalEvent = { type, at: new Date().toISOString(), ...payload };
    await this.fh.write(`${JSON.stringify(event)}\n`);
  }

  async close(result: RunResultRecord): Promise<void> {
    if (this.fh) {
      try {
        await this.fh.close();
      } catch {
        // best effort
      }
      this.fh = null;
    }
    await writeFile(join(this.dir, "result.json"), JSON.stringify(result, null, 2));
  }
}

export async function startRun(
  plugin: string,
  trigger: string,
): Promise<{ journal: RunJournal; runId: string }> {
  const runId = generateRunId(plugin);
  const journal = new RunJournal(runId, plugin, trigger, new Date().toISOString());
  await journal.open();
  return { journal, runId };
}

export async function listRuns(limit = 20): Promise<RunSummary[]> {
  let dirents: string[];
  try {
    dirents = await readdir(historyDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // runId starts with a sortable timestamp — reverse sort gives newest first.
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

  const status: RunSummary["status"] = result ? result.status : "running";
  const startedMs = Date.parse(manifest.startedAt);
  const finishedMs = result ? Date.parse(result.finishedAt) : NaN;
  return {
    ...manifest,
    status,
    finishedAt: result?.finishedAt,
    durationMs:
      Number.isFinite(startedMs) && Number.isFinite(finishedMs)
        ? finishedMs - startedMs
        : undefined,
    promotedCount: result?.promoted?.length,
  };
}

export async function readEvents(runId: string): Promise<JournalEvent[]> {
  const path = join(runDirOf(runId), "events.ndjson");
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: JournalEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as JournalEvent);
    } catch {
      // tolerate partial last line during a tail-in-progress
    }
  }
  return out;
}

export interface TailHandle {
  stop: () => Promise<void>;
}

/**
 * Live-tail a run's events.ndjson. Calls `onEvent` for each new event as it's
 * appended. When `result.json` appears, calls `onComplete` and stops itself.
 *
 * Implementation: poll-based — fs.watch on macOS is unreliable across editors
 * and tmpdirs, and a chokidar dependency is overkill for an append-only file.
 * Polling at 100 ms is fine for human-facing tail output.
 */
export async function tailRun(
  runId: string,
  onEvent: (event: JournalEvent) => void,
  onComplete?: (result: RunResultRecord) => void,
): Promise<TailHandle> {
  const dir = runDirOf(runId);
  const eventsPath = join(dir, "events.ndjson");
  const resultPath = join(dir, "result.json");

  let offset = 0;
  let buf = "";
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const st = await stat(eventsPath);
      if (st.size > offset) {
        const fh = await open(eventsPath, "r");
        try {
          const length = st.size - offset;
          const chunk = Buffer.alloc(length);
          await fh.read(chunk, 0, length, offset);
          offset = st.size;
          buf += chunk.toString("utf-8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              onEvent(JSON.parse(line) as JournalEvent);
            } catch {
              // skip malformed line
            }
          }
        } finally {
          await fh.close();
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    try {
      const raw = await readFile(resultPath, "utf-8");
      const result = JSON.parse(raw) as RunResultRecord;
      stopped = true;
      onComplete?.(result);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const interval = setInterval(() => {
    void tick();
  }, 100);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
