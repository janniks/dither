import { join } from "node:path";
import { assertInitialized } from "./config";

/**
 * Library-relative path helpers. Each call loads config and resolves through
 * the configured `library.path`. Callsites that already have a loaded config
 * should use the explicit *FromConfig variants below to avoid re-reading.
 *
 * Dither-home paths (pid, locks, plugins, grants, runs, env, status snapshot,
 * daemon log, qmd index db) live in `home.ts` and never go through here —
 * they're independent of the library config.
 */

export async function libraryRoot(): Promise<string> {
  return (await assertInitialized()).library.path;
}

export async function collectionDir(name: string): Promise<string> {
  return join(await libraryRoot(), name);
}

export function libraryRootFromConfig(cfg: { library: { path: string } }): string {
  return cfg.library.path;
}

export function collectionDirFromConfig(cfg: { library: { path: string } }, name: string): string {
  return join(cfg.library.path, name);
}
