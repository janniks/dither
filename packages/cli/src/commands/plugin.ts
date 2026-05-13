import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { libraryRoot } from "../paths";
import { resolveWatchPath } from "../watch-paths";
import { appendToInbox, type WatchTarget } from "../inbox";
import { installPlugin, MISSING_ENV, type InstallOptions, type InstalledPlugin } from "../plugin-install";
import { runPlugin, PLUGIN_NOT_INSTALLED } from "../plugin-run";
import { listPlugins } from "../plugin-list";
import { removePlugin } from "../plugin-remove";
import { resolveHome } from "../home";
import { assertInitialized } from "../config";
import { reloadDaemon, startDaemon, readDaemonPid } from "../daemon-control";
import { installAutostart } from "../persistence";
import { readFileSync } from "node:fs";
import { FDA_SETTINGS_URI, FDA_REQUIRED } from "../tcc-hint";

// Install a plugin and convert known user-facing failures (e.g. missing env)
// into a clean stderr line + exit(1) instead of citty's default stack trace.
async function installPluginOrExit(opts: InstallOptions): Promise<InstalledPlugin> {
  try {
    return await installPlugin(opts);
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e?.code === MISSING_ENV) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(1);
    }
    throw err;
  }
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
    description: "Install a plugin from a local path.",
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
    return result;
  },
});

const runSubcommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a plugin once. Accepts an installed plugin name or a path to a plugin directory (auto-installs).",
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

    if (args.backfill) {
      const seeded = await seedBackfillInbox(pluginName);
      if (seeded === 0) {
        console.log(
          `backfill: ${pluginName} watch.collections matched 0 .md files — nothing to do.`,
        );
        return { runId: null, promoted: [] };
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
