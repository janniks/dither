import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Cron } from "croner";
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
import { resolveHome } from "../home";
import { assertInitialized } from "../config";
import { reloadDaemon, startDaemon, readDaemonPid } from "../daemon-control";
import { installAutostart } from "../persistence";
import { readFileSync } from "node:fs";
import { FDA_SETTINGS_URI, FDA_REQUIRED } from "../tcc-hint";

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
      merged = { source: opts.source, ...mergeInputs(base, extra) };
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
function printInstallHint(name: string, fromRunPath: boolean): void {
  const grantsPath = join(resolveHome(), "grants", `${name}.json`);
  let manifest: { schedule?: string; watch?: { collections?: string[] } } = {};
  try {
    const blob = JSON.parse(readFileSync(grantsPath, "utf-8")) as { manifest?: typeof manifest };
    manifest = blob.manifest ?? {};
  } catch {
    return;
  }
  if (fromRunPath) {
    process.stdout.write(`\nnote: grants persisted. future runs: 'dither plugin run ${name}'.\n`);
    return;
  }
  if (manifest.schedule) {
    try {
      const next = new Cron(parseSchedule(manifest.schedule)).nextRun();
      if (next) {
        process.stdout.write(`\nnext run: ${formatRelative(next.getTime() - Date.now())} (${next.toISOString()})\n`);
      }
    } catch {
      // Invalid schedule — daemon will surface the real error at fire time.
    }
    process.stdout.write(`next: dither plugin run ${name} (manual one-shot fire)\n`);
    return;
  }
  const watch = manifest.watch?.collections ?? [];
  if (watch.length > 0) {
    process.stdout.write(
      `\nnote: runs automatically when files change in: ${watch.join(", ")}\n` +
        `      'dither plugin run ${name}' fires it once.\n`,
    );
    return;
  }
  process.stdout.write(`\nnext: dither plugin run ${name}\n`);
}

function formatRelative(ms: number): string {
  if (ms < 0) return "now";
  const min = Math.round(ms / 60000);
  if (min < 1) return "in <1m";
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

async function ensureDaemonForPlugin(name: string): Promise<void> {
  // Read the just-written grants file to see if the plugin has schedule or watch.
  const grantsPath = join(resolveHome(), "grants", `${name}.json`);
  let needsDaemon = false;
  try {
    const blob = JSON.parse(readFileSync(grantsPath, "utf-8")) as {
      manifest?: { schedule?: string; watch?: { collections?: string[] } };
    };
    needsDaemon =
      Boolean(blob.manifest?.schedule) ||
      Boolean(blob.manifest?.watch?.collections && blob.manifest.watch.collections.length > 0);
  } catch {
    return;
  }
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
    ...grantArgs,
  },
  async run({ args }) {
    await assertInitialized();
    const grants = readGrantArgs(args);
    const result = await installPluginOrExit({ source: args.source, ...grants });
    console.log(`installed ${result.name}@${result.version}`);
    console.log(`  → ${result.dest}`);
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
      const installed = await installPluginOrExit({ source: candidatePath, ...grants });
      pluginName = installed.name;
      runOverrides = null;
      console.log(`installed ${installed.name}@${installed.version}`);
      await ensureDaemonForPlugin(installed.name).catch(() => {});
      printInstallHint(installed.name, true);
    }

    if (args.detach) {
      const home = resolveHome();
      const logsDir = join(home, "logs");
      mkdirSync(logsDir, { recursive: true });
      const logPath = join(logsDir, `${pluginName}-${Date.now()}.log`);
      const fd = openSync(logPath, "a");
      const child = spawn(process.execPath, [process.argv[1]!, "plugin", "run", pluginName], {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      console.log(`detached run for ${pluginName} (pid ${child.pid})`);
      console.log(`  logs: ${logPath}`);
      return { detached: true, pid: child.pid, logPath };
    }

    const tty = process.stderr.isTTY;
    let result;
    try {
      result = await runPlugin({
        name: pluginName,
        ...runOverrides,
        verbose: args.verbose,
        onProgress: (msg) => {
          if (tty) {
            process.stderr.write(`\r\x1b[K${msg.message}`);
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
      throw err;
    }
    if (tty) process.stderr.write("\r\x1b[K");

    console.log(`run ${result.runId} promoted ${result.promoted.length} entries:`);
    for (const path of result.promoted) {
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
    for (const p of plugins) {
      const cols = p.collections.length ? p.collections.join(",") : "-";
      const sched = p.schedule ?? "-";
      console.log(`${p.name}\t${p.version}\t${cols}\t${sched}`);
    }
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

export const pluginCommand = defineCommand({
  meta: {
    name: "plugin",
    description: "Manage plugins.",
  },
  subCommands: {
    install: installSubcommand,
    run: runSubcommand,
    list: listSubcommand,
    remove: removeSubcommand,
  },
});
