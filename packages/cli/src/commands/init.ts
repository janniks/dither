import { defineCommand } from "citty";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveHome } from "../home";
import { loadConfig, saveConfig, type DitherConfig } from "../config";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize dither and write config.json.",
  },
  async run() {
    const home = resolveHome();
    await mkdir(home, { recursive: true });

    const existing = await loadConfig();
    if (existing) {
      console.log(`dither is already initialized at ${home}`);
      console.log(`  library: ${existing.library.path}`);
      return existing;
    }

    const libraryPath = join(home, "library");
    await mkdir(libraryPath, { recursive: true });

    const cfg: DitherConfig = {
      schema: { version: 1 },
      library: { path: libraryPath },
    };
    await saveConfig(cfg);

    console.log(`initialized dither at ${home}`);
    console.log(`  library: ${libraryPath}`);
    return cfg;
  },
});
