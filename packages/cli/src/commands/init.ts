import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveHome } from "../home";
import { loadConfig, saveConfig, type DitherConfig } from "../config";
import { openStore } from "../store";
import { confirm, promptText, stepDone, stepFail, stepStart } from "../prompt";
import { tildePath } from "../display";
import { applyQmdImport, discoverQmdCollections } from "../qmd-import";
import { ProgressLine, embedLoop, formatDuration } from "../progress";
import { QmdDownloadCapture } from "../qmd-download-render";
import { welcomeDocExists, writeWelcomeIfMissing } from "../welcome-doc";

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
 * Default library path at `dither init`. Independent of where the config dir
 * lives — even if config sits at `$XDG_CONFIG_HOME/dither` or a custom
 * `$DITHER_DIR`, the library defaults to `~/.dither/library` unless the user
 * has opted into `$XDG_DATA_HOME`, in which case `$XDG_DATA_HOME/dither`.
 * Only consulted at init; the chosen value is frozen into `config.json`.
 */
export function defaultLibraryPath(): string {
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "dither");
  return join(homedir(), ".dither", "library");
}

/**
 * Best-effort model weight prefetch + initial embedding pass. qmd's
 * embedding/rerank models are downloaded lazily on first use — calling
 * `embed()` here triggers both the model download *and* the per-chunk
 * embedding so the first `dither search` doesn't hang on a surprise pause.
 *
 * Two visible sub-phases share this one call:
 *   1. Model weights download — qmd prints its own download bar to stdout.
 *      We bracket it with our own `→`/`✓` lines for context.
 *   2. Chunk embedding — once `onProgress` starts firing, the download is
 *      done; we tear down the weights step and start a ProgressLine.
 *
 * Embedding runs via `embedLoop`, which re-invokes `store.embed()` until a
 * call reports zero chunks done — this dodges qmd's hardcoded 10-min
 * `LLMSession` ceiling that would otherwise silently skip the tail of a
 * large library.
 *
 * Failure is non-fatal: search degrades to lex-only until the models land
 * on a later attempt.
 */
async function prefetchWeights(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const store = await openStore();
    if (!store) return { ok: true }; // empty library — nothing to do

    stepStart("downloading model weights (first run, may take a few minutes)...");
    const capture = new QmdDownloadCapture();
    capture.start();
    let progress: ProgressLine | null = null;
    let downloadFinished = false;

    const finishDownload = (): void => {
      if (downloadFinished) return;
      downloadFinished = true;
      const dlSummary = capture.finish();
      if (!dlSummary && !process.stdout.isTTY) {
        // Non-TTY path: capture never installed; emit a tidy line so logs
        // have a discernible "download done" event.
        stepDone("model weights ready");
      }
      // dlSummary handled: QmdDownloadCapture printed its own ✓ line.
      // Cached-model case: no buffer captured → no output; that's fine.
    };

    const summary = await embedLoop(store, (cumEmbedded, totalEstimate) => {
      finishDownload();
      if (!progress) {
        progress = new ProgressLine("embedding library");
      }
      progress.update(cumEmbedded, totalEstimate);
    });

    // Edge: embed had nothing to do (empty index). The capture window
    // must still be closed; the model may have been downloaded
    // beforehand if a previous run left it stale.
    finishDownload();

    const trunc =
      summary.truncated > 0 ? ` (${summary.truncated} truncated to fit 2048-token context)` : "";
    if (progress !== null) {
      (progress as ProgressLine).done(
        `embedded ${summary.chunks} chunks in ${formatDuration(summary.durationMs)}${trunc}`,
      );
    }
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
        "Library directory (where your .md entries live). Defaults to ~/.dither/library, or $XDG_DATA_HOME/dither when set. Pass an explicit path to keep your library outside the dither working directory — e.g. --library ~/Documents/dither — so it's visible alongside your other documents and easy to sync/back up independently.",
    },
    download: {
      type: "boolean",
      description: "Pre-download qmd model weights at init (--no-download to skip).",
      default: true,
    },
    welcome: {
      type: "boolean",
      description:
        "Write a welcome doc into <library>/welcome/welcome.md so the next-action epilogue can demonstrate `dither search` / `dither get`. Default on; pass `--no-welcome` to skip.",
      default: true,
    },
  },
  async run({ args }) {
    const home = resolveHome();
    await mkdir(home, { recursive: true });

    const existing = await loadConfig();
    if (existing) {
      console.log(`dither is already initialized at ${tildePath(home)}`);
      console.log(`  library: ${tildePath(existing.library.path)}`);
      if (args.library) {
        console.log("  (--library ignored — re-init isn't supported; remove config.json and re-run if you need to reconfigure)");
      }
      return existing;
    }

    // No config yet. Resolve library: explicit flag > interactive prompt
    // (TTY only) > error.
    const defaultLibrary = defaultLibraryPath();
    let requested: string;
    if (args.library) {
      requested = args.library;
    } else if (process.stdout.isTTY) {
      console.log("");
      console.log("Welcome to dither.");
      console.log("");
      try {
        requested = await promptText({
          message: `Where should your library live? (ENTER for ${tildePath(defaultLibrary)})`,
          placeholder: "e.g. ~/Documents/dither",
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
    confirm("library", `${tildePath(libraryPath)}${created ? " (created)" : ""}`);

    let cfg: DitherConfig = {
      schema: { version: 2 },
      library: { path: libraryPath },
      collections: { external: [] },
    };

    // Auto-adopt collections from an existing qmd config so qmd users get
    // a working `dither search` without per-collection setup. Silent no-op
    // when no qmd config is found. See specs/init-adopt-qmd.md.
    const discovery = await discoverQmdCollections(libraryPath);
    if (discovery.source) {
      const { cfg: adoptedCfg, diff } = applyQmdImport(cfg, discovery);
      cfg = adoptedCfg;
      stepDone(`found qmd config at ${tildePath(discovery.source.path)}`);
      if (diff.adopted.length > 0) {
        const names = diff.adopted
          .map((a) => (a.renamedFrom ? `${a.name} (renamed from ${a.renamedFrom})` : a.name))
          .join(", ");
        console.log(`  adopted ${diff.adopted.length} collection${diff.adopted.length === 1 ? "" : "s"}: ${names}`);
      }
      if (diff.skippedInLibrary.length > 0) {
        console.log(`  skipped ${diff.skippedInLibrary.length} (inside library): ${diff.skippedInLibrary.join(", ")}`);
      }
      for (const s of diff.skippedInvalid) {
        console.log(`  skipped ${s.name}: ${s.reason}`);
      }
      for (const w of discovery.warnings) {
        console.log(`  warning: ${w}`);
      }
    }

    await saveConfig(cfg);
    stepDone(`wrote ${tildePath(join(home, "config.json"))}`);

    // Write the welcome doc *before* indexing so it's part of what the
    // index sees on the first pass. The doc demonstrates the
    // search → get pattern that the init epilogue then recommends —
    // search hits this file at the very top because it's the only doc
    // matching "welcome to dither" verbatim. `--no-welcome` skips
    // entirely; the epilogue falls back to the plugin-install line.
    if (args.welcome) {
      const welcome = await writeWelcomeIfMissing(libraryPath);
      if (welcome.written) {
        stepDone(`wrote welcome doc to ${tildePath(welcome.path)}`);
      }
      // existing-file path: silent — user may have edited it.
    }

    // Initialize the qmd index over the new library's subdirs. Empty
    // library → openStore returns null and no SQLite is created until a
    // plugin promotes content; that's fine, schema is created lazily then.
    const store = await openStore();
    if (!store) {
      stepDone("library empty — index deferred");
    } else {
      const progress = new ProgressLine("indexing library");
      const startedAt = Date.now();
      const result = await store.update({
        onProgress: ({ current, total }) => progress.update(current, total),
      });
      const filesTouched = result.indexed + result.updated;
      const summary =
        filesTouched > 0
          ? `indexed ${filesTouched} file${filesTouched === 1 ? "" : "s"} in ${formatDuration(Date.now() - startedAt)}`
          : `library scanned — no files to index`;
      progress.done(summary);
    }

    if (args.download) {
      const result = await prefetchWeights();
      if (!result.ok) {
        stepFail(`weight prefetch failed: ${result.reason} (search will fall back to lex-only)`);
      }
      // Success path prints its own `✓ embedded …` / `✓ model weights ready`.
    } else {
      stepDone("weights skipped (--no-download)");
    }

    console.log("");
    if (welcomeDocExists(libraryPath)) {
      console.log("next:");
      console.log("  dither search 'welcome to dither'");
      console.log("  dither get <id from above>");
    } else {
      console.log("next: dither plugin install <path>");
    }
    return cfg;
  },
});
