import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveWatchPath } from "../watch-paths";
import { appendToInbox, type WatchTarget } from "../inbox";
import { Cron } from "croner";
import pc from "picocolors";
import { formatRelTime } from "../relative-time";
import { installPlugin, MissingInputsError, type InstallOptions, type InstalledPlugin } from "../plugin-install";
import {
  InstallCancelledError,
  mergeInputs,
  promptInteractive,
  readExistingGrants,
  readPackage,
} from "../plugin-install-interactive";
import { parseSchedule } from "../schedule-parser";
import { hasKick, signalDaemon, writeKick, type KickOverrides } from "../kicks";
import { generateRunId } from "../run-log";
import { isLockHeld } from "../locks";
import { pluginDir as pluginDirOf } from "../home";
import { listPlugins } from "../plugin-list";
import { removePlugin } from "../plugin-remove";
import { ditherText, printTable, promptConfirm } from "../prompt";
import { formatRelPast } from "../relative-time";
import { openBrowser } from "../open-browser";
import { resolveHome, runResultPath } from "../home";
import { assertInitialized, libraryRoot } from "../config";
import { reloadDaemon, startDaemon, readDaemonPid } from "../daemon-control";
import { installAutostart } from "../persistence";
import { readFileSync } from "node:fs";
import { FDA_SETTINGS_URI, FDA_REQUIRED, type ProtectedInstall } from "../tcc-hint";
import {
  findLastRunForPlugin,
  followRun,
  listRuns,
  readRun,
  type RunResultRecord,
} from "../run-log";
import { oauthSubcommand } from "./plugin-oauth";

// Install a plugin. On a TTY, drop into the interactive flow when the
// manifest declares required env/files the caller didn't satisfy. On a
// pipe / CI, surface MissingInputsError as a single enumerated stderr
// line + exit 1, instead of citty's stack trace.
async function installPluginOrExit(opts: InstallOptions): Promise<InstalledPlugin> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  let merged = opts;
  if (interactive) {
    try {
      const parsed = await readPackage(opts.source);
      // Layer existing grants under the flag inputs (flags win) so a
      // reinstall pre-fills the prompts with the user's prior answers.
      const existing = await readExistingGrants(parsed.name);
      const base = existing ? mergeInputs(existing, opts) : opts;
      const extra = await promptInteractive(parsed, opts, existing);
      // Spread opts first so non-grant fields (source, symlink) ride
      // through; the prompt-merged grant fields overwrite opts's.
      merged = { ...opts, ...mergeInputs(base, extra) };
    } catch (err) {
      // Ctrl-C from consola.prompt rejects; treat that (and any other
      // pre-install failure surfaced during planning) as a clean abort
      // with no plugin code copied, no grants written.
      if (err instanceof InstallCancelledError || isCancel(err)) {
        process.stderr.write("\ninstall cancelled.\n");
        process.exit(130);
      }
      throw err;
    }
  }
  try {
    return await installPlugin(merged);
  } catch (err) {
    if (err instanceof MissingInputsError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

// consola's cancel-on-reject path throws a plain `Error("[consola] Prompt
// cancelled.")`. Match the message rather than relying on a stable type.
function isCancel(err: unknown): boolean {
  return err instanceof Error && /cancel/i.test(err.message);
}

/**
 * End-of-install hint pointing at the obvious next action. Pulls the
 * just-written grants file to inspect the manifest:
 *   - `schedule:` plugin → relative + absolute next-fire preview + manual hint
 *   - `watch:` plugin → "this runs automatically" + manual hint
 *   - everything else → `next: dither plugin run <name>`
 *
 * When called from `plugin run <path>`, the focus shifts to "future runs"
 * — the install just happened, the run is happening right now.
 */
interface ConsentedGrants {
  schedule?: string | null;
  watch?: { collections?: string[] } | null;
}

function readConsentedGrants(name: string): ConsentedGrants | null {
  const grantsPath = join(resolveHome(), "grants", `${name}.json`);
  try {
    return JSON.parse(readFileSync(grantsPath, "utf-8")) as ConsentedGrants;
  } catch {
    return null;
  }
}

function printInstallHint(name: string, fromRunPath: boolean): void {
  const grants = readConsentedGrants(name);
  if (!grants) return;
  if (fromRunPath) {
    process.stdout.write(`\nnote: grants persisted. future runs: 'dither plugin run ${name}'.\n`);
    return;
  }
  // `next run:` prints only when the user actually consented to scheduling.
  // Manual-only (null) and legacy grants (absent) both suppress it.
  if (grants.schedule) {
    try {
      const next = new Cron(parseSchedule(grants.schedule)).nextRun();
      if (next) {
        process.stdout.write(pc.dim(`\nnext run: ${formatRelTime(next.getTime())} (${next.toISOString()})\n`));
      }
    } catch {
      // Invalid schedule — daemon will surface the real error at fire time.
    }
    process.stdout.write(pc.dim(`next: dither plugin run ${name} (manual one-shot fire)\n`));
    return;
  }
  const watch = grants.watch?.collections ?? [];
  if (watch.length > 0) {
    process.stdout.write(
      pc.dim(`\nnote: runs automatically when files change in: ${watch.join(", ")}\n` +
        `      'dither plugin run ${name}' fires it once.\n`),
    );
    return;
  }
  process.stdout.write(pc.dim(`\nnext: dither plugin run ${name}\n`));
}


/**
 * Render the macOS Full Disk Access advisory in Dither's voice and, on a
 * TTY, offer to open System Settings now. On Yes spawn the deep link via
 * `openBrowser`; on No leave the URL in the note for later. Non-TTY just
 * prints the note (no prompt).
 *
 * `open` is injectable so tests don't actually spawn a Settings window.
 */
/**
 * Smoke-test whether the *managed deno binary* can read a TCC-protected
 * path. Node's own FDA grant doesn't transfer — plugins run under the
 * managed deno, which has its own per-binary entry in System Settings.
 * So we spawn `deno eval` with `--allow-read=<path>` and a `statSync`.
 * Exit 0 → access works (silent advisory); anything else → surface it.
 *
 * Times out at 3s as a safety net (deno cold start is usually <500ms,
 * but FDA prompts on first hit can hang briefly).
 */
async function denoCanRead(denoPath: string, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const code = `Deno.statSync(${JSON.stringify(path)});`;
    const child = spawn(denoPath, ["eval", `--allow-read=${path}`, code], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 3_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function handleProtectedInstall(
  info: ProtectedInstall,
  open: (url: string) => void = openBrowser,
): Promise<void> {
  // Skip the advisory when the managed deno already has FDA for this
  // path — the user already granted it. Only surface when actually blocked.
  if (await denoCanRead(info.callerBinary, info.path)) return;
  ditherText(
    [
      `'${info.path}' is a macOS-protected location.`,
      "",
      "The plugin will only read it after Full Disk Access has been",
      "granted to the dither-managed Deno:",
      `  ${info.callerBinary}`,
      "",
      "Drag the highlighted binary from Finder into the Full Disk",
      "Access list, or click '+' and pick it.",
      "",
      `Open Settings: ${info.settingsUri}`,
    ].join("\n"),
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  let yes: boolean;
  try {
    yes = await promptConfirm("Open System Settings now to grant Full Disk Access?", true);
  } catch {
    // Cancelled (Ctrl-C). Leave the URL in the note for later.
    return;
  }
  if (!yes) return;
  open(info.settingsUri);
  if (process.platform === "darwin") {
    spawn("open", ["-R", info.callerBinary], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  }
}

async function ensureDaemonForPlugin(name: string): Promise<void> {
  const grants = readConsentedGrants(name);
  if (!grants) return;
  const needsDaemon =
    Boolean(grants.schedule) ||
    Boolean(grants.watch?.collections && grants.watch.collections.length > 0);
  if (!needsDaemon) return;

  // Lazy spawn if not already running.
  const alive = await readDaemonPid();
  if (!alive) {
    try {
      await startDaemon();
    } catch (err) {
      console.error(
        `note: could not start daemon automatically (${err instanceof Error ? err.message : String(err)}). ` +
          `run 'dither daemon start' to bring it up.`,
      );
      return;
    }
  } else {
    // Already running — let it pick up the new plugin.
    await reloadDaemon().catch(() => {});
  }

  // Best-effort autostart unit. Opt-in registration via DITHER_INSTALL_AUTOSTART=1.
  if (process.env.DITHER_INSTALL_AUTOSTART === "1") {
    try {
      await installAutostart();
    } catch (err) {
      console.error(
        `note: autostart unit not installed (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }
}

function parsePairs(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

const grantArgs = {
  env: {
    type: "string" as const,
    description: "Comma-separated NAME=VALUE pairs for declared env (literals).",
  },
  "allow-env": {
    type: "string" as const,
    description: "Comma-separated env names this plugin may read from `dither env`.",
  },
  file: {
    type: "string" as const,
    description: "Comma-separated ID=PATH pairs for declared files.",
  },
  "allow-net": {
    type: "string" as const,
    description: "Comma-separated hosts this plugin may reach. Subset of manifest `net`.",
  },
  "allow-collection": {
    type: "string" as const,
    description:
      "Comma-separated collections this plugin may write to. Subset of manifest `collections`.",
  },
};

interface GrantArgs {
  env?: string;
  "allow-env"?: string;
  file?: string;
  "allow-net"?: string;
  "allow-collection"?: string;
}

function readGrantArgs(args: GrantArgs) {
  return {
    env: parsePairs(args.env),
    envRefs: parseList(args["allow-env"]),
    files: parsePairs(args.file),
    net: parseList(args["allow-net"]),
    collections: parseList(args["allow-collection"]),
  };
}

const installSubcommand = defineCommand({
  meta: {
    name: "install",
    description:
      "Install a plugin from a local path. Persists grants but doesn't run the plugin — use 'dither plugin run' for that.",
  },
  args: {
    source: {
      type: "positional",
      required: true,
      description: "Path to the plugin directory",
    },
    symlink: {
      type: "boolean",
      description:
        "Dev mode: symlink the install destination to the source path instead of copying. Author edits take effect without reinstall; node_modules + deno.json from the source are used as-is.",
      default: false,
    },
    ...grantArgs,
  },
  async run({ args }) {
    await assertInitialized();
    const grants = readGrantArgs(args);
    const result = await installPluginOrExit({
      source: args.source,
      ...grants,
      ...(args.symlink ? { symlink: true } : {}),
    });
    console.log(`\ninstalled ${result.name}@${result.version}${args.symlink ? " (symlinked)" : ""}`);
    console.log(`  → ${result.dest}`);
    if (result.protectedInstall) await handleProtectedInstall(result.protectedInstall);
    await ensureDaemonForPlugin(result.name).catch(() => {});
    printInstallHint(result.name, false);
    return result;
  },
});

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

const runSubcommand = defineCommand({
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

    // Tail the journal. Ctrl-c during the tail stops tailing only — the
    // daemon owns the run. The "detached" hint surfaces on user-initiated
    // abort so accidental key presses don't read as a lost run.
    await tailRun(runId);
    return { runId };
  },
});

/**
 * Y/n prompt — bare Enter or Y/y opens the System Settings → Full Disk
 * Access pane. Anything starting with N/n skips. Best-effort; failures to
 * spawn `open` are swallowed (the URI is already in the printed hint).
 */
async function maybeOpenFdaSettings(): Promise<void> {
  process.stderr.write("\nOpen System Settings now? [Y/n]: ");
  const answer = await new Promise<string>((res) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.off("data", onData);
        res(buf.slice(0, nl).trim());
      }
    };
    process.stdin.on("data", onData);
  });
  if (/^n/i.test(answer)) return;
  await new Promise<void>((res) => {
    const child = spawn("open", [FDA_SETTINGS_URI], { stdio: "ignore", detached: true });
    child.on("error", () => res());
    child.on("exit", () => res());
  });
}

const listSubcommand = defineCommand({
  meta: {
    name: "list",
    description: "List installed plugins.",
  },
  async run() {
    const plugins = await listPlugins();
    if (plugins.length === 0) {
      console.log("(no plugins installed)");
      return plugins;
    }
    const rows = plugins.map((p) => {
      const cols = p.collections.length ? p.collections.join(",") : "-";
      const sched = p.schedule ?? "-";
      let next = "";
      if (p.schedule) {
        try {
          const at = new Cron(p.schedule).nextRun();
          if (at) next = formatRelTime(at.getTime());
        } catch {
          // malformed cron — leave next blank rather than crash the list.
        }
      }
      return [p.name, p.version, cols, sched, next];
    });
    // Clamp the collections column so a plugin with many collections
    // doesn't push schedule + next off-screen.
    printTable(rows, [{}, {}, { max: 40 }, {}, {}]);
    return plugins;
  },
});

const removeSubcommand = defineCommand({
  meta: {
    name: "remove",
    description: "Uninstall a plugin (deletes plugin code, state, and grants).",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Plugin name",
    },
  },
  async run({ args }) {
    await removePlugin({ name: args.name });
    console.log(`removed ${args.name}`);
    await reloadDaemon().catch(() => {});
    return { name: args.name };
  },
});

// `generateRunId` (run-log.ts) emits `YYYYMMDDTHHMMSS-<plugin>-<8hex>`.
// Plugin names can't satisfy this shape because the date prefix is rigid.
const RUN_ID_PATTERN = /^\d{8}T\d{6}-[A-Za-z0-9._-]+-[0-9a-f]{8}$/;

function formatRunDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

async function readResult(runId: string): Promise<RunResultRecord | null> {
  try {
    const raw = await readFile(runResultPath(runId), "utf-8");
    return JSON.parse(raw) as RunResultRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function listRecentRuns(limit: number, verbose: boolean): Promise<void> {
  const runs = await listRuns(limit);
  if (runs.length === 0) {
    console.log("No runs yet. Try `dither plugin run <name>`.");
    return;
  }
  const now = Date.now();
  const rows = runs.map((r) => {
    const rel = formatRelPast(Date.parse(r.startedAt), now);
    const dur = formatRunDuration(r.durationMs);
    const added = `${r.addedCount ?? 0} added`;
    return verbose
      ? [r.runId, r.status, r.plugin, rel, r.startedAt, dur, added]
      : [r.runId, r.status, r.plugin, rel, dur, added];
  });
  // Right-align duration so 1m5s lines up with 234ms.
  const cols = verbose
    ? [{}, {}, {}, {}, {}, { align: "right" as const }, {}]
    : [{}, {}, {}, {}, { align: "right" as const }, {}];
  printTable(rows, cols);
}

async function tailRun(runId: string): Promise<void> {
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

const runsSubcommand = defineCommand({
  meta: {
    name: "runs",
    description:
      "Inspect plugin runs. No arg lists recent runs. A run id tails/replays it. A plugin name tails/replays that plugin's most-recent run.",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description: "Run id or installed plugin name. Omit to list recent runs.",
    },
    limit: {
      type: "string",
      description: "When listing: how many runs to show (default 20).",
      default: "20",
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "When listing: also show the exact ISO start timestamp.",
      default: false,
    },
  },
  async run({ args }) {
    const target = args.target;
    if (target === undefined) {
      await listRecentRuns(Number.parseInt(args.limit, 10) || 20, args.verbose);
      return;
    }
    if (RUN_ID_PATTERN.test(target)) {
      if (!existsSync(join(resolveHome(), "history", target))) {
        process.stderr.write(`no run found with id ${target}\n`);
        process.exit(1);
      }
      await tailRun(target);
      return;
    }
    const last = await findLastRunForPlugin(target);
    if (!last) {
      process.stderr.write(
        `no runs yet for '${target}' — try 'dither plugin run ${target}'\n`,
      );
      process.exit(1);
    }
    await tailRun(last.runId);
  },
});

export const pluginCommand = defineCommand({
  meta: {
    name: "plugin",
    description: "Manage plugins.",
  },
  subCommands: {
    install: installSubcommand,
    run: runSubcommand,
    runs: runsSubcommand,
    list: listSubcommand,
    remove: removeSubcommand,
    oauth: oauthSubcommand,
  },
});
