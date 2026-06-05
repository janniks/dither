import { mkdir, writeFile, unlink } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pidFilePath, resolveHome } from "./home";
import { Queue, type Outcome, type Source } from "./queue";

/**
 * Per-plugin kick row. Persisted at `<home>/kicks/<plugin>.json` — the
 * pending file of the kick `Queue`. Written by the CLI's `plugin run <name>`
 * and consumed by the daemon's kick `Source` (SIGUSR1 → drain at runtime,
 * once at boot). One pending file per plugin; a second kick before the first
 * is consumed is rejected at the CLI by a kick-or-lock pre-check.
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

/**
 * The kick queue. `latest` shape: at most one pending kick per plugin, a
 * fresh enqueue replaces it. Pending file == `<home>/kicks/<plugin>.json`,
 * the path the CLI's `writeKick` producer writes directly.
 */
const queue = new Queue<KickPayload>({ dir: "kicks", ext: "json", shape: "latest" });

function kickPath(plugin: string): string {
  assertSafePluginName(plugin);
  return join(resolveHome(), "kicks", `${plugin}.json`);
}

function assertSafePluginName(plugin: string): void {
  if (!plugin || plugin.includes("/") || plugin.includes("\\") || plugin === "." || plugin === "..") {
    throw new Error(`invalid plugin name: ${JSON.stringify(plugin)}`);
  }
}

/**
 * CLI producer: write a pending kick. Direct file write (not `queue.enqueue`)
 * so the CLI doesn't depend on Queue internals — the path is the contract,
 * and the daemon's drain claims whatever pending file is present.
 */
export async function writeKick(plugin: string, payload: KickPayload): Promise<void> {
  const p = kickPath(plugin);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2));
}

/** Remove a pending kick. ENOENT-tolerant. Used by the CLI's interrupt cleanup. */
export async function clearKick(plugin: string): Promise<void> {
  try {
    await unlink(kickPath(plugin));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Synchronously check for a pending kick. Used by the CLI's pre-check to
 * reject `d plugin run X` when X already has a kick in flight.
 */
export function hasKick(plugin: string): boolean {
  return existsSync(kickPath(plugin));
}

/** The fire callback the daemon hands the kick source. Returns done/retry. */
export type FireKick = (plugin: string, payload: KickPayload) => Promise<Outcome>;

/**
 * Kicks as a `Source` over the kick `Queue`. `start` registers SIGUSR1 →
 * drain; `recover` drains once at boot (kicks that landed while the daemon
 * was down). Both paths run the same `fire` per claimed kick. Thin adapter —
 * all durability (claim/ack/restore, atomic write) lives in the Queue.
 *
 * The extra `drain()` on the return is a **test seam only** — the daemon
 * drives kicks purely through `start`/`recover`/`stop`. Tests call `drain()`
 * to exercise one drain without the SIGUSR1 plumbing. Not part of `Source`.
 */
export function kickSource(fire: FireKick): Source & { drain(): Promise<void> } {
  const drainAll = async (): Promise<void> => {
    for (const plugin of await queue.pendingNames()) {
      await queue.drain(plugin, (payload) => fire(plugin, payload));
    }
  };
  const onUsr1 = (): void => {
    void drainAll().catch((err) => {
      console.error(`[daemon] kick drain failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  return {
    drain: drainAll,
    start(): void {
      process.on("SIGUSR1", onUsr1);
    },
    async recover() {
      // Re-queue any kick claimed-but-unacked by a crashed prior daemon,
      // then drain everything pending on disk.
      await queue.recoverAll();
      await drainAll();
    },
    stop() {
      process.off("SIGUSR1", onUsr1);
    },
  };
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
