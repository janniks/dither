import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveWatchPath } from "../watch-paths";
import { appendToInbox, type WatchTarget } from "../inbox";
import { Cron } from "croner";
import { formatRelTime } from "../relative-time";
import { installPlugin, MissingInputsError, type InstallOptions, type InstalledPlugin } from "../plugin-install";
import {
  InstallCancelledError,
  mergeInputs,
  planInstall,
  promptInteractive,
  readExistingGrants,
  readPackage,
} from "../plugin-install-interactive";
import { parseSchedule } from "../schedule-parser";
import { runPlugin, PLUGIN_NOT_INSTALLED } from "../plugin-run";
import { listPlugins } from "../plugin-list";
import { removePlugin } from "../plugin-remove";
import { ditherText, fitOneLine, printTable, promptConfirm } from "../prompt";
import { formatRelPast } from "../relative-time";
import { openBrowser } from "../open-browser";
import { resolveHome } from "../home";
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
      const plan = await planInstall(parsed, base);
      const missing = plan.ok ? [] : plan.missing;
      const extra = await promptInteractive(parsed, base, missing);
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
        process.stdout.write(`\nnext run: ${formatRelTime(next.getTime())} (${next.toISOString()})\n`);
      }
    } catch {
      // Invalid schedule — daemon will surface the real error at fire time.
    }
    process.stdout.write(`next: dither plugin run ${name} (manual one-shot fire)\n`);
    return;
  }
  const watch = grants.watch?.collections ?? [];
  if (watch.length > 0) {
    process.stdout.write(
      `\nnote: runs automatically when files change in: ${watch.join(", ")}\n` +
        `      'dither plugin run ${name}' fires it once.\n`,
    );
    return;
  }
  process.stdout.write(`\nnext: dither plugin run ${name}\n`);
}


/**
 * Render the macOS Full Disk Access advisory in Dither's voice and, on a
 * TTY, offer to open System Settings now. On Yes spawn the deep link via
 * `openBrowser`; on No leave the URL in the note for later. Non-TTY just
 * prints the note (no prompt).
 *
 * `open` is injectable so tests don't actually spawn a Settings window.
 */
export async function handleProtectedInstall(
  info: ProtectedInstall,
  open: (url: string) => void = openBrowser,
): Promise<void> {
  ditherText(
    [
      `'${info.path}' is a macOS-protected location.`,
      "",
      "The plugin will only read it after Full Disk Access has been",
      "granted to the dither-managed Deno:",
      `  ${info.callerBinary}`,
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
  if (yes) open(info.settingsUri);
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

function appendStringArg(argv: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) argv.push(flag, value);
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
    console.log(`installed ${result.name}@${result.version}${args.symlink ? " (symlinked)" : ""}`);
    console.log(`  → ${result.dest}`);
    if (result.protectedInstall) await handleProtectedInstall(result.protectedInstall);
    await ensureDaemonForPlugin(result.name).catch(() => {});
    printInstallHint(result.name, false);
    return result;
  },
});

const runSubcommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Fire a plugin once. Accepts an installed plugin name, or a path to a plugin directory (auto-installs via 'dither plugin install' first).",
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
        "Fork the run into the background and return immediately. Stdout/stderr are captured to a log file.",
      default: false,
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description:
        "Forward plugin stderr (Deno output, console.log/error) to your terminal in real time.",
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

    if (args.detach) {
      const home = resolveHome();
      const logsDir = join(home, "logs");
      mkdirSync(logsDir, { recursive: true });
      const logPath = join(logsDir, `${pluginName}-${Date.now()}.log`);
      const fd = openSync(logPath, "a");
      const childArgs = [process.argv[1]!, "plugin", "run", pluginName];
      if (args.backfill) childArgs.push("--backfill");
      if (args.verbose) childArgs.push("--verbose");
      if (args["no-auto-open"]) childArgs.push("--no-auto-open");
      if (runOverrides) {
        appendStringArg(childArgs, "--env", args.env);
        appendStringArg(childArgs, "--allow-env", args["allow-env"]);
        appendStringArg(childArgs, "--file", args.file);
        appendStringArg(childArgs, "--allow-net", args["allow-net"]);
        appendStringArg(childArgs, "--allow-collection", args["allow-collection"]);
      }
      const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      console.log(`detached run for ${pluginName} (pid ${child.pid})`);
      console.log(`  logs: ${logPath}`);
      return { detached: true, pid: child.pid, logPath };
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

    const tty = process.stderr.isTTY;
    let result;
    try {
      result = await runPlugin({
        name: pluginName,
        ...runOverrides,
        ...(args.backfill ? { trigger: "watch" as const } : {}),
        verbose: args.verbose,
        onProgress: (msg) => {
          if (tty) {
            // Middle-truncate so the line fits on one terminal row.
            // `\r\x1b[K` only clears one visual line — if the message
            // wraps, the next rewrite leaves the overflow as garbage.
            const cols = process.stderr.columns ?? 80;
            process.stderr.write(`\r\x1b[K${fitOneLine(msg.message, cols)}`);
          } else {
            process.stderr.write(`${msg.message}\n`);
          }
        },
      });
    } catch (err) {
      if (tty) process.stderr.write("\r\x1b[K");
      const e = err as Error & { code?: string; exitCode?: number };
      if (e?.code === FDA_REQUIRED) {
        process.stderr.write(`${e.message}\n`);
        if (!args["no-auto-open"] && process.stdin.isTTY && process.stderr.isTTY) {
          await maybeOpenFdaSettings();
        }
        process.exit(e.exitCode ?? 1);
      }
      if (e?.code === PLUGIN_NOT_INSTALLED) {
        process.stderr.write(`error: ${e.message}\n`);
        process.stderr.write(`hint: run 'dither plugin list' to see installed plugins.\n`);
        process.exit(1);
      }
      // Plugin process exited non-zero. Without --verbose the ChildProcess
      // stack trace citty would print is noise — replay via `plugin runs`
      // shows the actual plugin output. With --verbose, plugin stderr
      // already streamed live; keep the throw so the stack lands too.
      if (e?.exitCode !== undefined && !args.verbose) {
        process.stderr.write(`error: ${e.message}\n`);
        process.stderr.write(
          `hint: run 'dither plugin runs ${pluginName}' to replay this run's output.\n`,
        );
        process.exit(e.exitCode ?? 1);
      }
      throw err;
    }
    if (tty) process.stderr.write("\r\x1b[K");

    console.log(`run ${result.runId} added ${result.added.length} documents:`);
    for (const path of result.added) {
      console.log(`  ${path}`);
    }
    return result;
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

function resultPath(runId: string): string {
  return join(resolveHome(), "history", runId, "result.json");
}

async function readResult(runId: string): Promise<RunResultRecord | null> {
  try {
    const raw = await readFile(resultPath(runId), "utf-8");
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
