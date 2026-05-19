import { defineCommand } from "citty";
import { existsSync, writeFileSync } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveHome } from "../home";
import { loadConfig, saveConfig, type DitherConfig } from "../config";
import { confirm, promptText, stepDone, stepFail, stepStart } from "../prompt";
import { tildePath } from "../display";
import { applyQmdImport, discoverQmdCollections } from "../qmd-import";
import { ProgressLine, formatDuration } from "../progress";
import { QmdDownloadCapture } from "../qmd-download-render";
import { welcomeDocExists, writeWelcomeIfMissing } from "../welcome-doc";
import { readDaemonPid, startDaemon } from "../daemon-control";
import { followEvents, type BaseEvent } from "../events-log";
import { embedDisabledPath } from "../daemon-jobs";

/**
 * Resolve a `--library <path>` value into a canonical, writable directory
 * path. Creates the directory (and parents) if it doesn't exist; rejects
 * file targets and non-writable existing directories.
 *
 * Canonicalisation via `realpath` pins the configured library to the
 * resolved target. Same rationale as install-time file grants — replacing
 * a symlink later must not silently widen the library scope.
 */
export async function resolveLibraryPath(
  input: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ path: string; created: boolean }> {
  const expanded = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  const absolute = resolve(expanded);

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
    return { path: await realpath(absolute), created: false };
  }

  const parent = dirname(absolute);
  if (!existsSync(parent)) {
    throw new Error(`parent directory does not exist: ${parent}`);
  }
  try {
    await access(parent, constants.W_OK);
  } catch {
    throw new Error(`parent directory is not writable: ${parent}`);
  }

  if (opts.dryRun) return { path: absolute, created: true };
  await mkdir(absolute, { recursive: true });
  return { path: await realpath(absolute), created: true };
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
 * Foreground watch of the daemon's reconcile cycle. Opens the events
 * log at its current end, signals the daemon via SIGHUP, then follows
 * the log, rendering progress lines and model-download summaries as
 * events arrive. Returns when the daemon emits `reconcile-done`.
 *
 * Per-job state machine: a `job-started` event spawns a ProgressLine
 * (for indexing/embedding) or a QmdDownloadCapture (for model-download);
 * `job-progress` updates the line; `job-done` finalizes with the rich
 * summary; `job-skipped` / `job-failed` emit a stepFail and continue.
 *
 * Daemon-dead detection: if no events arrive in 5s AND the daemon PID
 * is no longer alive, we exit with an error. The watch is non-blocking
 * for the user (Ctrl-C lands in phase 7).
 */
async function watchDaemonReconcile(): Promise<{
  ok: boolean;
  reason?: string;
  detached?: boolean;
}> {
  const pid = await readDaemonPid();
  if (!pid) {
    return { ok: false, reason: "daemon not running" };
  }

  const ac = new AbortController();
  const iter = followEvents(ac.signal);

  // Single Ctrl-C (SIGINT) or terminal close (SIGHUP) disconnects the
  // watcher cleanly — the daemon never sees the signal (it's detached
  // with its own session). Init prints a detach block + epilogue and
  // exits 0. The actual cancel-the-running-job path is a separate
  // explicit command (`dither index cancel`).
  let detached = false;
  const onDetach = (): void => {
    if (detached) return;
    detached = true;
    ac.abort();
  };
  process.on("SIGINT", onDetach);
  process.on("SIGHUP", onDetach);

  // Trigger the reconcile after we're positioned at the log end. There's
  // a small race window where the SIGHUP-induced reconcile-started could
  // fire before our follower's first poll; followEvents seeks to current
  // end of file at open, and the next 100ms poll catches the new lines.
  await new Promise((r) => setTimeout(r, 50));
  try {
    process.kill(pid, "SIGHUP");
  } catch (err) {
    ac.abort();
    return { ok: false, reason: `signal daemon failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Per-job UI state. Keys are jobId; values are the ProgressLine for
  // index/embed or the QmdDownloadCapture for model-download.
  const progressByJob = new Map<string, ProgressLine>();
  const downloadCaptures = new Map<string, { capture: QmdDownloadCapture; startedAt: number }>();
  let cycleStarted = false;
  let result: { ok: boolean; reason?: string } = { ok: true };

  const cleanup = (): void => {
    for (const p of progressByJob.values()) p.done("interrupted");
    for (const { capture } of downloadCaptures.values()) capture.finish();
    progressByJob.clear();
    downloadCaptures.clear();
  };

  const watchdog = setTimeout(() => undefined, 0);
  clearTimeout(watchdog);
  let lastEventAt = Date.now();
  const watchdogTimer = setInterval(() => {
    if (Date.now() - lastEventAt < 5_000) return;
    // No event for 5s — is the daemon still alive?
    try {
      process.kill(pid, 0);
    } catch {
      result = { ok: false, reason: "daemon died mid-reconcile" };
      ac.abort();
    }
  }, 1_000);

  try {
    for await (const event of iter) {
      lastEventAt = Date.now();
      if (event.kind === "reconcile-started") {
        cycleStarted = true;
        continue;
      }
      if (!cycleStarted) continue; // pre-cycle noise (e.g. daemon-started from a previous fire)
      if (event.kind === "reconcile-done") {
        break;
      }
      if (event.kind === "reconcile-failed") {
        result = {
          ok: false,
          reason: `daemon reconcile failed: ${String(event.error ?? "unknown")}`,
        };
        break;
      }
      handleJobEvent(event, progressByJob, downloadCaptures);
    }
  } finally {
    clearInterval(watchdogTimer);
    ac.abort();
    cleanup();
    process.off("SIGINT", onDetach);
    process.off("SIGHUP", onDetach);
  }
  if (detached) {
    return { ok: true, detached: true };
  }
  return result;
}

function handleJobEvent(
  event: BaseEvent,
  progressByJob: Map<string, ProgressLine>,
  downloadCaptures: Map<string, { capture: QmdDownloadCapture; startedAt: number }>,
): void {
  const jobId = typeof event.jobId === "string" ? event.jobId : null;
  const type = typeof event.type === "string" ? event.type : null;
  if (!jobId || !type) return;

  if (event.kind === "job-started") {
    if (type === "model-download") {
      stepStart("downloading model weights (first run, may take a few minutes)...");
      const capture = new QmdDownloadCapture();
      capture.start();
      downloadCaptures.set(jobId, { capture, startedAt: Date.now() });
    } else if (type === "indexing") {
      progressByJob.set(jobId, new ProgressLine("indexing library"));
    } else if (type === "embedding") {
      // Close any in-flight download capture: model is ready, embed has begun.
      // (Daemon emits job-done for download before job-started for embed in
      // the cached-model case, but we belt-and-suspenders here.)
      for (const [dlId, { capture }] of downloadCaptures) {
        capture.finish();
        downloadCaptures.delete(dlId);
      }
      progressByJob.set(jobId, new ProgressLine("embedding library"));
    }
    return;
  }

  if (event.kind === "job-progress") {
    const line = progressByJob.get(jobId);
    if (!line) return;
    const current = typeof event.current === "number" ? event.current : 0;
    const total = typeof event.total === "number" ? event.total : 0;
    line.update(current, total);
    return;
  }

  if (event.kind === "job-done") {
    if (type === "model-download") {
      const dl = downloadCaptures.get(jobId);
      if (dl) {
        dl.capture.finish();
        downloadCaptures.delete(jobId);
      }
      return;
    }
    const line = progressByJob.get(jobId);
    if (!line) return;
    if (type === "indexing") {
      const filesIndexed = typeof event.filesIndexed === "number" ? event.filesIndexed : 0;
      line.done(
        filesIndexed > 0
          ? `indexed ${filesIndexed} file${filesIndexed === 1 ? "" : "s"}`
          : "library scanned — no files to index",
      );
    } else if (type === "embedding") {
      const chunks = typeof event.chunks === "number" ? event.chunks : 0;
      const durationMs = typeof event.durationMs === "number" ? event.durationMs : 0;
      const truncated = typeof event.truncated === "number" ? event.truncated : 0;
      const trunc = truncated > 0 ? ` (${truncated} truncated to fit 2048-token context)` : "";
      line.done(`embedded ${chunks} chunks in ${formatDuration(durationMs)}${trunc}`);
    }
    progressByJob.delete(jobId);
    return;
  }

  if (event.kind === "job-skipped") {
    const reason = typeof event.reason === "string" ? event.reason : "unknown";
    stepFail(`${type} skipped (${reason})`);
    return;
  }

  if (event.kind === "job-failed") {
    const error = typeof event.error === "string" ? event.error : "unknown error";
    stepFail(`${type} failed: ${error}`);
    progressByJob.delete(jobId);
    downloadCaptures.delete(jobId);
    return;
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
    wait: {
      type: "boolean",
      description:
        "Block until the daemon finishes indexing + embedding (default). Pass `--no-wait` to dispatch the work and return immediately; check progress later with `dither status`.",
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
              await resolveLibraryPath(v, { dryRun: true });
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

    // `--no-download` means: skip embedding for this init. We honor it
    // by writing the embed-disabled marker so the daemon's reconciler
    // skips the embed phase. `dither index update` clears it.
    if (!args.download) {
      writeFileSync(embedDisabledPath(), "", "utf-8");
      stepDone("weights skipped (--no-download)");
    }

    // Long-running work (model download, indexing, embedding) now runs
    // inside the daemon. Init ensures the daemon is up, then watches
    // the events log as it reconciles qmd state. See daemon-jobs.ts.
    //
    // Test bypass: vitest tests don't want to spawn real daemons; we
    // skip the watch in that environment. Daemon-jobs has its own
    // isolated tests that don't depend on init.
    const inTestMode = process.env.VITEST_WORKER_ID !== undefined || process.env.CI === "true";
    if (!inTestMode) {
      stepStart("starting dither daemon...");
      const daemonStart = await startDaemon();
      stepDone(
        daemonStart.alreadyRunning
          ? `daemon already running (pid ${daemonStart.pid})`
          : `daemon started (pid ${daemonStart.pid})`,
      );

      if (!args.wait) {
        // --no-wait: signal the daemon to reconcile, then exit without
        // following the events log. CI / scripted use case.
        try {
          process.kill(daemonStart.pid, "SIGHUP");
        } catch (err) {
          stepFail(
            `signal daemon failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        stepDone("dispatched — daemon will finish in background");
        console.log("  dither status         # check progress");
      } else {
        const watchResult = await watchDaemonReconcile();
        if (watchResult.detached) {
          console.log("");
          stepDone("detached — daemon continues in the background");
          console.log("  dither status         # check progress");
          console.log("  dither index cancel   # stop the running job");
        } else if (!watchResult.ok) {
          stepFail(`${watchResult.reason} (search will fall back to lex-only until next run)`);
        }
      }
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
