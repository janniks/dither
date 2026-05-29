import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveWatchPath } from "../watch-paths";
import { appendToInbox, type WatchTarget } from "../inbox";
import { assertInitialized, libraryRoot } from "../config";
import { hasKick, signalDaemon, writeKick, type KickOverrides } from "../kicks";
import { followRun, generateRunId, readRun, type RunResultRecord } from "../run-log";
import { isLockHeld } from "../locks";
import { pluginDir as pluginDirOf, resolveHome, runResultPath } from "../home";
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
  if (grants.collections.length > 0) out.collections = grants.collections;
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
  const grantsPath = join(resolveHome(), "grants", `${name}.json`);
  const blob = JSON.parse(readFileSync(grantsPath, "utf-8")) as {
    manifest?: { watch?: { collections?: string[] } };
  };
  const collections = blob.manifest?.watch?.collections ?? [];
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
      printInstallHint(installed.name, true);
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

    if (!existsSync(pluginDirOf(pluginName))) {
      process.stderr.write(`error: plugin not installed: '${pluginName}'\n`);
      process.stderr.write(`hint: run 'dither plugin list' to see installed plugins.\n`);
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
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    });
    await ensureDaemonRunning();
    signalDaemon();

    if (args.detach) {
      console.log(`kicked ${pluginName} (run ${runId})`);
      console.log(`  tail with: dither plugin runs ${runId}`);
      return { runId, detached: true };
    }

    await tailRun(runId);
    return { runId };
  },
});
