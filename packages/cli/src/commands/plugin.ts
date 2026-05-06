import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { installPlugin, type InputValue } from "../plugin-install";
import { runPlugin } from "../plugin-run";
import { listPlugins } from "../plugin-list";
import { removePlugin } from "../plugin-remove";
import { resolveHome } from "../home";

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
    input: {
      type: "string",
      description: "Comma-separated KEY=VALUE pairs for declared text/secret inputs",
    },
    file: {
      type: "string",
      description: "Comma-separated KEY=PATH pairs for declared file inputs",
    },
  },
  async run({ args }) {
    const inputs = parsePairs(args.input) as Record<string, InputValue>;
    const files = parsePairs(args.file);
    const result = await installPlugin({ source: args.source, inputs, files });
    console.log(`installed ${result.name}@${result.version}`);
    console.log(`  → ${result.dest}`);
    return result;
  },
});

const runSubcommand = defineCommand({
  meta: {
    name: "run",
    description: "Run an installed plugin once.",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Plugin name (must be installed)",
    },
    detach: {
      type: "boolean",
      description:
        "Fork the run into the background and return immediately. Stdout/stderr are captured to a log file.",
      default: false,
    },
  },
  async run({ args }) {
    if (args.detach) {
      const home = resolveHome();
      const logsDir = join(home, "logs");
      mkdirSync(logsDir, { recursive: true });
      const logPath = join(logsDir, `${args.name}-${Date.now()}.log`);
      const fd = openSync(logPath, "a");
      const child = spawn(process.execPath, [process.argv[1]!, "plugin", "run", args.name], {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      console.log(`detached run for ${args.name} (pid ${child.pid})`);
      console.log(`  logs: ${logPath}`);
      return { detached: true, pid: child.pid, logPath };
    }

    const tty = process.stderr.isTTY;
    const result = await runPlugin({
      name: args.name,
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
