import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Dither-home paths only. Library paths (entries, collection dirs) live in
 * `paths.ts` and route through the config file. The qmd index sqlite stays
 * here — it's dither-managed bookkeeping, not user content.
 */
export function resolveHome(): string {
  return process.env.DITHER_HOME ?? join(homedir(), ".dither");
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
