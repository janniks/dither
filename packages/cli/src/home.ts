import { homedir } from "node:os";
import { join } from "node:path";

export function resolveHome(): string {
  return process.env.DITHER_HOME ?? join(homedir(), ".dither");
}

export function entriesDir(): string {
  return join(resolveHome(), "entries");
}

export function indexDbPath(): string {
  return join(resolveHome(), "qmd-index.sqlite");
}

export function globalEnvPath(): string {
  return join(resolveHome(), "env.json");
}
