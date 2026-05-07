import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { access, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { resolveHome, indexDbPath } from "../home";
import { loadConfig, saveConfig, type DitherConfig } from "../config";
import { openStore } from "../store";

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

/**
 * Best-effort model weight prefetch. qmd's embedding/rerank models are
 * downloaded lazily on first use — calling `embed()` here triggers that
 * load now so the first `dither search` doesn't hang on a surprise
 * download. Failure is non-fatal: search degrades to lex-only until the
 * models land on a later attempt.
 */
async function prefetchWeights(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const store = await openStore();
    if (!store) return { ok: true }; // empty library — nothing to do
    await store.embed();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
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
    force: {
      type: "boolean",
      description: "Overwrite an existing config; rebuild the qmd index.",
      default: false,
    },
    download: {
      type: "boolean",
      description: "Pre-download qmd model weights at init (--no-download to skip).",
      default: true,
    },
  },
  async run({ args }) {
    const home = resolveHome();
    await mkdir(home, { recursive: true });

    const existing = await loadConfig();
    if (existing && !args.force) {
      console.log(`dither is already initialized at ${home}`);
      console.log(`  library: ${existing.library.path}`);
      console.log("  re-run with --force to reconfigure");
      return existing;
    }

    const requested = args.library ?? join(home, "library");
    const { path: libraryPath, created } = await resolveLibraryPath(requested);

    // On --force, the dbPath is the same but its contents reference the old
    // library's subdirs. Drop it so the next openStore registers the new
    // library's subdirs and store.update() rebuilds from scratch.
    //
    // We do NOT lock against in-flight plugin runs here. A run that resolved
    // its libraryRoot before this point will promote into the old library
    // and leave its files orphaned of the new index. See
    // notes/qmd-library-edge-cases.md (#1). Running daemons also need a
    // SIGHUP-driven reconcile to pick up the new library — see (#5).
    if (existing && args.force) {
      const dbPath = indexDbPath();
      if (existsSync(dbPath)) {
        await rm(dbPath, { force: true });
      }
    }

    const cfg: DitherConfig = {
      schema: { version: 1 },
      library: { path: libraryPath },
    };
    await saveConfig(cfg);

    // Initialize / rebuild the qmd index over the new library's subdirs.
    // Empty library → openStore returns null and no SQLite is created until
    // a plugin promotes content; that's fine, schema is created lazily then.
    const store = await openStore();
    if (store) await store.update();

    let weightsNote = "";
    if (args.download) {
      const result = await prefetchWeights();
      if (!result.ok) {
        weightsNote = ` (weight prefetch failed: ${result.reason}; search will fall back to lex-only)`;
      }
    } else {
      weightsNote = " (--no-download: weights not prefetched)";
    }

    console.log(`${existing ? "reconfigured" : "initialized"} dither at ${home}`);
    console.log(`  library: ${libraryPath}${created ? " (created)" : ""}${weightsNote}`);
    return cfg;
  },
});
