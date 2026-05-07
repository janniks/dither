import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { installPlugin } from "../plugin-install";
import { runPlugin } from "../plugin-run";
import { listPlugins } from "../plugin-list";
import { removePlugin } from "../plugin-remove";
import { resolveHome } from "../home";
import { reloadDaemon } from "../daemon-control";

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
    const grants = readGrantArgs(args);
    const result = await installPlugin({ source: args.source, ...grants });
    console.log(`installed ${result.name}@${result.version}`);
    console.log(`  → ${result.dest}`);
    await reloadDaemon().catch(() => {});
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
    ...grantArgs,
  },
  async run({ args }) {
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
      const installed = await installPlugin({ source: candidatePath, ...grants });
      pluginName = installed.name;
      runOverrides = null;
      console.log(`installed ${installed.name}@${installed.version}`);
      await reloadDaemon().catch(() => {});
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
    const result = await runPlugin({
      name: pluginName,
      ...runOverrides,
      onProgress: (msg) => {
        if (tty) {
          process.stderr.write(`\r\x1b[K${msg.message}`);
        } else {
          process.stderr.write(`${msg.message}\n`);
        }
      },
    });
    if (tty) process.stderr.write("\r\x1b[K");

    console.log(`run ${result.runId} promoted ${result.promoted.length} entries:`);
    for (const path of result.promoted) {
      console.log(`  ${path}`);
    }
    return result;
  },
});

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
