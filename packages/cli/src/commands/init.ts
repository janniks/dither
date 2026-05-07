import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { resolveHome } from "../home";
import { loadConfig, saveConfig, type DitherConfig } from "../config";

/**
 * Resolve a `--library <path>` value into a canonical, writable directory
 * path. Creates the directory (and parents) if it doesn't exist; rejects
 * file targets and non-writable existing directories.
 *
 * Canonicalisation via `realpath` pins the configured library to the
 * resolved target. Same rationale as install-time file grants — replacing
 * a symlink later must not silently widen the library scope.
 */
async function resolveLibraryPath(input: string): Promise<{ path: string; created: boolean }> {
  const absolute = resolve(input);
  let created = false;

  if (existsSync(absolute)) {
    const stat = await lstat(absolute);
    // If the path is a symlink, resolve to the real target before checking
    // type — a symlink to a directory is fine, a symlink to a file is not.
    const targetForCheck = stat.isSymbolicLink() ? await realpath(absolute) : absolute;
    const targetStat = await lstat(targetForCheck);
    if (!targetStat.isDirectory()) {
      throw new Error(`library path is not a directory: ${absolute}`);
    }
    try {
      await access(targetForCheck, constants.W_OK);
    } catch {
      throw new Error(`library path is not writable: ${absolute}`);
    }
  } else {
    await mkdir(absolute, { recursive: true });
    created = true;
  }

  return { path: await realpath(absolute), created };
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize dither and write config.json.",
  },
  args: {
    library: {
      type: "string",
      description: "Library directory (default: <dither-home>/library).",
    },
  },
  async run({ args }) {
    const home = resolveHome();
    await mkdir(home, { recursive: true });

    const existing = await loadConfig();
    if (existing) {
      console.log(`dither is already initialized at ${home}`);
      console.log(`  library: ${existing.library.path}`);
      return existing;
    }

    const requested = args.library ?? join(home, "library");
    const { path: libraryPath, created } = await resolveLibraryPath(requested);

    const cfg: DitherConfig = {
      schema: { version: 1 },
      library: { path: libraryPath },
    };
    await saveConfig(cfg);

    console.log(`initialized dither at ${home}`);
    console.log(`  library: ${libraryPath}${created ? " (created)" : ""}`);
    return cfg;
  },
});
