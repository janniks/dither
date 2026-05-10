import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveHome } from "../home";
import { loadConfig, saveConfig, type DitherConfig } from "../config";
import { openStore } from "../store";
import { promptText } from "../prompt";

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
  const expanded = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  const absolute = resolve(expanded);
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
      description:
        "Library directory (where your .md entries live). Defaults to <DITHER_DIR>/library. Pass an explicit path to keep your library outside the dither working directory — e.g. --library ~/Documents/dither — so it's visible alongside your other documents and easy to sync/back up independently.",
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
    if (existing) {
      console.log(`dither is already initialized at ${home}`);
      console.log(`  library: ${existing.library.path}`);
      if (args.library) {
        console.log("  (--library ignored — re-init isn't supported; remove config.json and re-run if you need to reconfigure)");
      }
      return existing;
    }

    // No config yet. Resolve library: explicit flag > interactive prompt
    // (TTY only) > error.
    const defaultLibrary = join(home, "library");
    let requested: string;
    if (args.library) {
      requested = args.library;
    } else if (process.stdout.isTTY) {
      console.log("");
      console.log("Welcome to dither.");
      console.log("");
      try {
        requested = await promptText({
          message: "Where should your library live?",
          hint: `ENTER to use default ${defaultLibrary}`,
          placeholder: "~/Documents/dither",
          default: defaultLibrary,
          validate: async (v) => {
            if (!v.trim()) return "path cannot be empty";
            try {
              await resolveLibraryPath(v);
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        });
      } catch {
        // Cancelled (Ctrl-C). Exit cleanly with no partial state.
        console.log("\ninit cancelled.");
        process.exit(130);
      }
    } else {
      console.error(
        "error: --library is required when not running on a TTY (no prompt available).",
      );
      console.error("       e.g. dither init --library ~/Documents/dither");
      process.exit(2);
    }

    const { path: libraryPath, created } = await resolveLibraryPath(requested);

    const cfg: DitherConfig = {
      schema: { version: 1 },
      library: { path: libraryPath },
    };
    await saveConfig(cfg);

    // Initialize the qmd index over the new library's subdirs. Empty
    // library → openStore returns null and no SQLite is created until a
    // plugin promotes content; that's fine, schema is created lazily then.
    const store = await openStore();
    if (store) await store.update();

    let weightsOk = false;
    let weightsReason: string | undefined;
    if (args.download) {
      const result = await prefetchWeights();
      weightsOk = result.ok;
      weightsReason = result.reason;
    }

    // End-of-init summary: three short lines + a one-line next-step nudge.
    console.log("");
    console.log(`✓ wrote ${join(home, "config.json")}`);
    console.log(`✓ ${created ? "created" : "using"} library at ${libraryPath}`);
    if (args.download) {
      if (weightsOk) {
        console.log("✓ pre-downloaded model weights");
      } else {
        console.log(
          `⚠ weight prefetch failed: ${weightsReason} (search will fall back to lex-only)`,
        );
      }
    } else {
      console.log("• weights skipped (--no-download)");
    }
    console.log("");
    console.log("next: dither plugin install <path>");
    return cfg;
  },
});
