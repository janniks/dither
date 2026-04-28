import { defineCommand } from "citty";
import { installPlugin, type InputValue } from "../plugin-install";
import { runPlugin } from "../plugin-run";
import { listPlugins } from "../plugin-list";
import { removePlugin } from "../plugin-remove";

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
  },
  async run({ args }) {
    const result = await runPlugin({ name: args.name });
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
