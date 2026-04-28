import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./home";

export interface RemoveOptions {
  name: string;
}

export async function removePlugin(opts: RemoveOptions): Promise<void> {
  const home = resolveHome();
  const pluginDir = join(home, "plugins", opts.name);
  const grantsPath = join(home, "grants", `${opts.name}.json`);

  if (!existsSync(pluginDir) && !existsSync(grantsPath)) {
    throw new Error(`Plugin '${opts.name}' is not installed.`);
  }

  // Wipe plugin code + state + grants. State preservation is a v2 concern.
  if (existsSync(pluginDir)) {
    await rm(pluginDir, { recursive: true, force: true });
  }
  if (existsSync(grantsPath)) {
    await rm(grantsPath, { force: true });
  }
}
