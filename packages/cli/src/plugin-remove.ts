import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { grantsPath, pluginDir } from "./home";

export interface RemoveOptions {
  name: string;
}

export function isInstalled(name: string): boolean {
  return existsSync(pluginDir(name)) || existsSync(grantsPath(name));
}

export async function removePlugin(opts: RemoveOptions): Promise<void> {
  if (!isInstalled(opts.name)) {
    throw new Error(`Plugin '${opts.name}' is not installed.`);
  }

  // Wipe plugin code + state + grants. State preservation is a v2 concern.
  const dir = pluginDir(opts.name);
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (existsSync(grantsPath(opts.name))) {
    await rm(grantsPath(opts.name), { force: true });
  }
}
