import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config-dir paths only — dither's own machine state (daemon runtime,
 * plugins, grants, locks, journals). Library paths (entries, collection
 * dirs) live in `config.ts` and route through the config file. The qmd
 * index sqlite stays here — it's dither-managed bookkeeping, not user
 * content.
 *
 * Resolution chain for the config dir, first match wins:
 *   1. $DITHER_DIR (explicit)
 *   2. $XDG_CONFIG_HOME/dither (Linux convention)
 *   3. ~/.dither (fallback)
 */

export function configDir(): string {
  if (process.env.DITHER_DIR) return process.env.DITHER_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "dither");
  return join(homedir(), ".dither");
}

export function indexDbPath(): string {
  return join(configDir(), "qmd-index.sqlite");
}

export function globalEnvPath(): string {
  return join(configDir(), "env.json");
}

export function grantsDirPath(): string {
  return join(configDir(), "grants");
}

export function grantsPath(name: string): string {
  return join(grantsDirPath(), `${name}.json`);
}

export function pidFilePath(): string {
  return join(configDir(), "dither.pid");
}

export interface DaemonPidFile {
  pid: number;
  token: string;
  startedAt: string;
}

/**
 * Strict parse of the PID file body. `null` on any malformed shape —
 * callers map that to `bad-pidfile` (probe) or "not ours" (shutdown
 * self-check). The single parser for `dither.pid`.
 */
export function parsePidFile(raw: string): DaemonPidFile | null {
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

export function daemonLogPath(): string {
  return join(configDir(), "logs", "daemon.log");
}

export function statusSnapshotPath(): string {
  return join(configDir(), "status.json");
}

/**
 * Global scope of the Run-log — daemon lifecycle, Job progress, Reconciler
 * ticks. One file, 1 MB rotation threshold. See `run-log.ts`.
 */
export function runLogPath(): string {
  return join(configDir(), "run-log.jsonl");
}

/** Per-Run scope of the Run-log. See `run-log.ts`. */
export function runEventsPath(runId: string): string {
  return join(configDir(), "history", runId, "events.jsonl");
}

/** Terminal state of a Run, written by `openRun.close`. */
export function runResultPath(runId: string): string {
  return join(configDir(), "history", runId, "result.json");
}

/** Install root of an installed plugin. */
export function pluginDir(name: string): string {
  return join(configDir(), "plugins", name);
}

export function locksDirPath(): string {
  return join(configDir(), "locks");
}

export function binDir(): string {
  return join(configDir(), "bin");
}

/** Per-(plugin,collection) mtime watermark for the watcher's boot catch-up. */
export function watchStatePath(key: string): string {
  return join(configDir(), "watch-state", `${key}.json`);
}

export function watchStateDir(): string {
  return join(configDir(), "watch-state");
}

/** Per-plugin `lastRun` for the scheduler's anacron boot catch-up. */
export function scheduleStatePath(plugin: string): string {
  return join(configDir(), "schedule-state", `${plugin}.json`);
}

export function scheduleStateDir(): string {
  return join(configDir(), "schedule-state");
}
