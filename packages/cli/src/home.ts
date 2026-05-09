import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Dither-home paths only. Library paths (entries, collection dirs) live in
 * `paths.ts` and route through the config file. The qmd index sqlite stays
 * here — it's dither-managed bookkeeping, not user content.
 *
 * Resolution chain for the dither working directory ("config dir"), first
 * match wins:
 *   1. $DITHER_DIR (explicit)
 *   2. $XDG_CONFIG_HOME/dither (Linux convention)
 *   3. $DITHER_HOME (deprecated alias — warns once per process)
 *   4. ~/.dither (fallback)
 */

let warnedHomeAlias = false;
function warnHomeAlias(): void {
  if (warnedHomeAlias) return;
  warnedHomeAlias = true;
  process.stderr.write(
    "warning: DITHER_HOME is deprecated; use DITHER_DIR (or XDG_CONFIG_HOME/dither). DITHER_HOME will be removed in the next release.\n",
  );
}

export function resolveHome(): string {
  if (process.env.DITHER_DIR) return process.env.DITHER_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "dither");
  if (process.env.DITHER_HOME) {
    warnHomeAlias();
    return process.env.DITHER_HOME;
  }
  return join(homedir(), ".dither");
}

/** Test-only: reset the once-per-process warning latch. */
export function _resetHomeWarningLatch(): void {
  warnedHomeAlias = false;
}

export function indexDbPath(): string {
  return join(resolveHome(), "qmd-index.sqlite");
}

export function globalEnvPath(): string {
  return join(resolveHome(), "env.json");
}

export function pidFilePath(): string {
  return join(resolveHome(), "dither.pid");
}

export function daemonLogPath(): string {
  return join(resolveHome(), "logs", "daemon.log");
}

export function statusSnapshotPath(): string {
  return join(resolveHome(), "status.json");
}

export function locksDirPath(): string {
  return join(resolveHome(), "locks");
}

export function binDir(): string {
  return join(resolveHome(), "bin");
}
