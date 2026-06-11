import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pluginDir, resolveHome } from "./home";

export interface RemoveOptions {
  name: string;
}

export function isInstalled(name: string): boolean {
  return existsSync(pluginDir(name)) || existsSync(join(resolveHome(), "grants", `${name}.json`));
}

export async function removePlugin(opts: RemoveOptions): Promise<void> {
  const dir = pluginDir(opts.name);
  const grantsPath = join(resolveHome(), "grants", `${opts.name}.json`);

  if (!isInstalled(opts.name)) {
    throw new Error(`Plugin '${opts.name}' is not installed.`);
  }

  // Wipe plugin code + state + grants. State preservation is a v2 concern.
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (existsSync(grantsPath)) {
    await rm(grantsPath, { force: true });
  }
}
