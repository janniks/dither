import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pidFilePath, resolveHome } from "./home";

/**
 * Per-plugin kick row. Persisted at `<home>/kicks/<plugin>.json`. Written
 * by the CLI's `plugin run <name>` and consumed by the daemon's SIGUSR1
 * handler. One file per plugin — a second kick before the first is picked
 * up is rejected at the CLI by a kick-or-lock pre-check.
 *
 * `runId`     — pre-assigned by the CLI so the tail follows a known path
 *               before the daemon opens the journal.
 * `kickedAt`  — ISO timestamp the CLI wrote the file.
 * `overrides` — per-run grant additions. Mirror today's `RunOptions`
 *               overrides at the `runPlugin` boundary.
 */
export interface KickPayload {
  runId: string;
  kickedAt: string;
  overrides?: KickOverrides;
}

export interface KickOverrides {
  env?: Record<string, string>;
  envRefs?: string[];
  files?: Record<string, string>;
  net?: string[];
  collections?: string[];
}

function kickDir(): string {
  return join(resolveHome(), "kicks");
}

function kickPath(plugin: string): string {
  assertSafePluginName(plugin);
  return join(kickDir(), `${plugin}.json`);
}

function assertSafePluginName(plugin: string): void {
  if (!plugin || plugin.includes("/") || plugin.includes("\\") || plugin === "." || plugin === "..") {
    throw new Error(`invalid plugin name: ${JSON.stringify(plugin)}`);
  }
}

export async function readKick(plugin: string): Promise<KickPayload | null> {
  try {
    const raw = await readFile(kickPath(plugin), "utf-8");
    return JSON.parse(raw) as KickPayload;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeKick(plugin: string, payload: KickPayload): Promise<void> {
  const p = kickPath(plugin);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2));
}

export async function clearKick(plugin: string): Promise<void> {
  try {
    await unlink(kickPath(plugin));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function listKicks(): Promise<Array<{ plugin: string; payload: KickPayload }>> {
  let entries: string[];
  try {
    entries = await readdir(kickDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Array<{ plugin: string; payload: KickPayload }> = [];
  for (const f of entries.toSorted()) {
    if (!f.endsWith(".json")) continue;
    const plugin = f.slice(0, -".json".length);
    const payload = await readKick(plugin);
    if (payload) out.push({ plugin, payload });
  }
  return out;
}

/**
 * Synchronously check for a pending kick. Used by the CLI's pre-check to
 * reject `d plugin run X` when X already has a kick in flight.
 */
export function hasKick(plugin: string): boolean {
  return existsSync(kickPath(plugin));
}

/**
 * Drain every pending kick by handing each one to the daemon's fire
 * callback, then unlinking the file. POSIX coalesces signals, so a single
 * SIGUSR1 may have to consume more than one kick; this scan covers them
 * all. Also runs once at daemon startup to recover kicks that landed
 * while the daemon was down.
 *
 * The `fire` callback returns void — sources don't await `runPlugin`
 * (Scheduler/Watcher/Refirer all just call `fireWithSuppress` and return).
 */
export async function scanKicks(
  fire: (plugin: string, payload: KickPayload) => void,
): Promise<void> {
  const all = await listKicks();
  for (const entry of all) {
    fire(entry.plugin, entry.payload);
    await clearKick(entry.plugin).catch(() => undefined);
  }
}

/**
 * Send SIGUSR1 to the daemon, telling it to drain `kicks/` now. No-op if
 * the pid file is missing, malformed, or points at a dead process — the
 * CLI's daemon-auto-start step is responsible for liveness; this helper
 * just signals.
 */
export function signalDaemon(): void {
  if (!existsSync(pidFilePath())) return;
  let raw: string;
  try {
    raw = readFileSync(pidFilePath(), "utf-8");
  } catch {
    return;
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    return;
  }
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGUSR1");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "ENOENT") return;
    throw err;
  }
}
