import { defineCommand } from "citty";
import { Cron } from "croner";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { resolveWatchPath } from "../watch-paths";
import { readGrants, writeGrants } from "../grants";
import { parseSchedule } from "../schedule-parser";
import { appendToInbox, type WatchTarget } from "../inbox";
import { assertInitialized, libraryRoot } from "../config";
import { clearKick, hasKick, signalDaemon, writeKick, type KickOverrides } from "../kicks";
import { followRun, generateRunId, readRun, type RunResultRecord } from "../run-log";
import { isLockHeld } from "../locks";
import { pluginDir as pluginDirOf, runResultPath } from "../paths";
import { readDaemonPid, startDaemon } from "../daemon-control";
import {
  grantArgs,
  readGrantArgs,
  installPluginOrExit,
  printInstallHint,
  ensureDaemonForPlugin,
} from "./command-plugin-shared";
import { handleProtectedInstall } from "./command-plugin-install";

/**
 * Ensure the daemon is up. The CLI is now a thin client — the daemon is
 * the sole supervisor for plugin runs — so every `plugin run` ensures
 * liveness before writing a kick. Reuses the existing startDaemon path
 * (lock-gated, polls the pid file). Dead daemon → spawn; alive → no-op.
 */
async function ensureDaemonRunning(): Promise<void> {
  const pid = await readDaemonPid();
  if (pid) return;
  await startDaemon();
}

function buildOverrides(grants: ReturnType<typeof readGrantArgs>): KickOverrides {
  const out: KickOverrides = {};
  if (Object.keys(grants.env).length > 0) out.env = grants.env;
  if (grants.envRefs.length > 0) out.envRefs = grants.envRefs;
  if (Object.keys(grants.files).length > 0) out.files = grants.files;
  if (grants.net.length > 0) out.net = grants.net;
  if (grants.create.length > 0) out.create = grants.create;
  if (grants.edit.length > 0) out.edit = grants.edit;
  return out;
}

async function walkMd(dir: string): Promise<WatchTarget[]> {
  const out: WatchTarget[] = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) out.push(...(await walkMd(full)));
    else if (s.isFile() && name.endsWith(".md")) {
      out.push({ path: full, mtime: new Date(s.mtimeMs).toISOString() });
    }
  }
  return out;
}

/**
 * Walk every watched collection for the named plugin, append each entry's
 * `(path, mtime)` to the inbox, return the total. The actual draining
 * happens through the normal fire pipeline — the caller invokes runPlugin
 * with trigger="watch", which claims the inbox at fire start.
 */
async function seedBackfillInbox(name: string): Promise<number> {
  const blob = await readGrants(name);
  const collections = blob?.manifest?.watch?.collections ?? [];
  if (collections.length === 0) {
    process.stderr.write(
      `error: --backfill needs a 'watch.collections' grant; '${name}' has none.\n`,
    );
    process.exit(1);
  }
  const root = await libraryRoot();
  let count = 0;
  for (const c of collections) {
    const targets = await walkMd(resolveWatchPath(root, c));
    for (const t of targets) {
      await appendToInbox(name, t);
      count += 1;
    }
  }
  return count;
}

/**
 * Bare durations ("15min", "10m") get the `every` prefix `parseSchedule` wants;
 * cron patterns and "daily at ..." pass through untouched.
 */
export function normalizeSchedule(input: string): string {
  const s = input.trim();
  const duration = /^\d+\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)$/i.test(s);
  return duration ? `every ${s}` : s;
}

/**
 * `--every` / `--watch`: persist a schedule or watch dir to the plugin's grant
 * and reload the daemon instead of firing now. Edits the top-level grant fields
 * the daemon actually reads (never `manifest.*`); `ensureDaemonForPlugin`
 * reloads (or starts) the daemon so the next reconcile picks the change up.
 */
async function configurePlugin(name: string, every?: string, watch?: string): Promise<void> {
  const grant = await readGrants(name);
  if (!grant) {
    process.stderr.write(`error: plugin '${name}' has no grants file — install it first.\n`);
    process.exit(1);
  }

  if (every !== undefined) {
    const sched = normalizeSchedule(every);
    // The scheduler silently skips an unparseable cron, so validate loudly here.
    try {
      new Cron(parseSchedule(sched));
    } catch {
      process.stderr.write(
        `error: '${every}' is not a valid schedule (cron like '0 */6 * * *' or 'every 15min').\n`,
      );
      process.exit(1);
    }
    grant.schedule = sched;
  }

  if (watch !== undefined) {
    // Route by notation, mirroring resolveWatchPath: a path (`/abs` or `./rel`)
    // is a literal dir → `watch.dirs`; a bare name is a library collection →
    // `watch.collections` (stored as the name, resolved to a dir at runtime).
    const isDir = isAbsolute(watch) || watch.startsWith("./") || watch.startsWith("../");
    const w = grant.watch ?? { collections: [] };
    if (isDir) {
      const dir = resolve(watch);
      if (!existsSync(dir)) {
        process.stderr.write(`warning: '${dir}' does not exist yet — it'll be watched once created.\n`);
      }
      const dirs = w.dirs ?? [];
      if (!dirs.includes(dir)) dirs.push(dir);
      w.dirs = dirs;
    }
    if (!isDir && !w.collections.includes(watch)) w.collections.push(watch);
    grant.watch = w;
  }

  await writeGrants(name, grant);
  await ensureDaemonForPlugin(name).catch(() => {});

  if (every !== undefined) console.log(`scheduled ${name}: ${normalizeSchedule(every)}`);
  if (watch !== undefined) {
    const isDir = isAbsolute(watch) || watch.startsWith("./") || watch.startsWith("../");
    console.log(`watching for ${name}: ${isDir ? resolve(watch) : watch}`);
  }
  console.log(`\nnext: dither plugin list`);
}

/**
 * Read a run's terminal result.json. Used both inline (tail-after-kick)
 * and by the `runs` subcommand for one-shot inspection.
 */
export async function readResult(runId: string): Promise<RunResultRecord | null> {
  try {
    const raw = await readFile(runResultPath(runId), "utf-8");
    return JSON.parse(raw) as RunResultRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Tail one run's event stream until it terminates. Replays past events,
 * then polls for result.json in parallel with the live event stream so
 * the terminal `_result` line always lands even if the journal file
 * rotated mid-tail. Imported by both the `run` and `runs` subcommands.
 */
export async function tailRun(runId: string): Promise<void> {
  const past = await readRun(runId);
  for (const e of past) console.log(JSON.stringify(e));

  const existing = await readResult(runId);
  if (existing) {
    console.log(JSON.stringify({ type: "_result", ...existing }));
    return;
  }

  const ac = new AbortController();
  const onSig = (): void => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  // Poll for result.json in parallel with the event stream. `inFlight`
  // guards against a slow read letting a second tick re-launch readResult.
  // `emitted` is only set AFTER readResult succeeds, so a partial-write
  // read failure leaves the loop free to retry. `readResult` returns null
  // on ENOENT, so no pre-existence check is needed.
  let inFlight = false;
  let emitted = false;
  const resultPoll = setInterval(() => {
    if (emitted || inFlight) return;
    inFlight = true;
    void readResult(runId)
      .then((r) => {
        if (!r) return;
        emitted = true;
        console.log(JSON.stringify({ type: "_result", ...r }));
        ac.abort();
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, 100);

  try {
    for await (const event of followRun(runId, ac.signal)) {
      console.log(JSON.stringify(event));
    }
  } finally {
    clearInterval(resultPoll);
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}

/**
 * Foreground-run interrupt cleanup: clear the kick this command wrote so an
 * interrupted `plugin run` can't leave a stale kick that reads as "already
 * running" forever while `plugin runs` shows nothing. Correct whether or not
 * the daemon already consumed the kick — if unconsumed it cancels the
 * request; if consumed the file is gone and `clearKick` is ENOENT-tolerant.
 * Does NOT stop an already-running daemon-side run (out of scope) — it only
 * stops the stale-kick lie.
 */
export async function clearKickOnInterrupt(plugin: string): Promise<void> {
  await clearKick(plugin).catch(() => undefined);
}

/**
 * Wire `clearKickOnInterrupt` onto SIGINT/SIGTERM for the duration of a
 * foreground tail. Returns a teardown that detaches the handlers. Only the
 * foreground path installs this; `--detach` returns before here, leaving the
 * kick for the daemon.
 */
function onInterrupt(plugin: string): () => void {
  const onSig = (): void => {
    void clearKickOnInterrupt(plugin).finally(() => process.exit(130));
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  return () => {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  };
}

export const runSubcommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Fire a plugin once. The daemon supervises the run; this command writes a kick and tails the journal until it finishes.",
  },
  args: {
    target: {
      type: "positional",
      required: true,
      description: "Installed plugin name OR path to a plugin directory",
    },
    detach: {
      type: "boolean",
      description:
        "Skip the tail and exit immediately after kicking the daemon. Use 'dither plugin runs <name>' to tail later.",
      default: false,
    },
    "no-auto-open": {
      type: "boolean",
      description:
        "Suppress the 'Open System Settings now? [Y/n]' prompt on a recognized FDA failure.",
      default: false,
    },
    backfill: {
      type: "boolean",
      description:
        "For watch plugins: walk every entry under the manifest's `watch.collections` and fire the plugin once with them all as targets. Use to seed an installed watch plugin against existing library state.",
      default: false,
    },
    symlink: {
      type: "boolean",
      description:
        "When the target is a path, install via symlink instead of copying (dev mode). See `plugin install --symlink`.",
      default: false,
    },
    every: {
      type: "string",
      description:
        "Set a schedule (cron like '0 */6 * * *' or 'every 15min') and reload the daemon — does not run now.",
    },
    watch: {
      type: "string",
      description:
        "Add a watch target and reload the daemon (does not run now). A path ('/abs' or './rel') is watched literally; a bare name is a library collection.",
    },
    ...grantArgs,
  },
  async run({ args }) {
    await assertInitialized();
    const grants = readGrantArgs(args);

    // If the target is an existing directory, treat as a path: install (or
    // reinstall) with the supplied flags as the persisted grants, then run
    // by name with no per-run overrides. If the target is a plain name, the
    // flags are per-run overrides layered on top of the existing grants.
    let pluginName = args.target;
    let runOverrides: ReturnType<typeof readGrantArgs> | null = grants;
    const candidatePath = resolve(args.target);
    const isPath = existsSync(candidatePath) && existsSync(join(candidatePath, "package.json"));
    if (isPath) {
      const installed = await installPluginOrExit({
        source: candidatePath,
        ...grants,
        ...(args.symlink ? { symlink: true } : {}),
      });
      pluginName = installed.name;
      runOverrides = null;
      console.log(`installed ${installed.name}@${installed.version}${args.symlink ? " (symlinked)" : ""}`);
      if (installed.protectedInstall) await handleProtectedInstall(installed.protectedInstall);
      await ensureDaemonForPlugin(installed.name).catch(() => {});
      await printInstallHint(installed.name, true);
    }

    if (!existsSync(pluginDirOf(pluginName))) {
      process.stderr.write(`error: plugin not installed: '${pluginName}'\n`);
      process.stderr.write(`hint: run 'dither plugin list' to see installed plugins.\n`);
      process.exit(1);
    }

    // --every / --watch configure the plugin's grant (schedule or watch dir)
    // and reload the daemon; they do NOT fire a run. Branch out before the
    // kick path so config works even while a run is in flight.
    if (args.every !== undefined || args.watch !== undefined) {
      await configurePlugin(pluginName, args.every, args.watch);
      return { plugin: pluginName, configured: true };
    }

    // Pre-check: a pending kick or a held lock means the plugin is already
    // queued/running. Reject rather than coalesce — keeps the model simple
    // (one kick per plugin) and surfaces a clear "tail-existing" message.
    if (hasKick(pluginName) || isLockHeld(pluginName)) {
      process.stderr.write(
        `${pluginName} is already running — tail with 'dither plugin runs ${pluginName}'\n`,
      );
      process.exit(1);
    }

    if (args.backfill) {
      const seeded = await seedBackfillInbox(pluginName);
      if (seeded === 0) {
        console.log(
          `backfill: ${pluginName} watch.collections matched 0 .md files — nothing to do.`,
        );
        return { runId: null, added: [] };
      }
      console.log(`backfill: seeded inbox with ${seeded} entries`);
    }

    // CLI assigns the runId so the tail can follow before the daemon has
    // opened the journal. The daemon honors a presupplied id in openRun.
    const runId = generateRunId(pluginName);
    const overrides = runOverrides ? buildOverrides(runOverrides) : {};
    await writeKick(pluginName, {
      runId,
      kickedAt: new Date().toISOString(),
      // Backfill seeds the inbox; only a watch-trigger run claims it.
      ...(args.backfill ? { trigger: "watch" as const } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    });
    await ensureDaemonRunning();
    signalDaemon();

    if (args.detach) {
      console.log(`kicked ${pluginName} (run ${runId})`);
      console.log(`  tail with: dither plugin runs ${runId}`);
      return { runId, detached: true };
    }

    // Foreground tail: own the kick we wrote so Ctrl-C clears it (above the
    // tail's own abort handler, which only stops the journal follow).
    const detach = onInterrupt(pluginName);
    try {
      await tailRun(runId);
    } finally {
      detach();
    }
    return { runId };
  },
});
