import { defineCommand } from "citty";
import { getGlobalEnv, setGlobalEnv, unsetGlobalEnv, listGlobalEnv } from "../global-env";

const setSubcommand = defineCommand({
  meta: {
    name: "set",
    description: "Set a global env value (creates or replaces).",
  },
  args: {
    name: { type: "positional", required: true, description: "Env name" },
    value: { type: "positional", required: true, description: "Env value" },
  },
  async run({ args }) {
    await setGlobalEnv(args.name, args.value);
    console.log(`set ${args.name}`);
    return { name: args.name };
  },
});

const getSubcommand = defineCommand({
  meta: {
    name: "get",
    description: "Print a global env value.",
  },
  args: {
    name: { type: "positional", required: true, description: "Env name" },
  },
  async run({ args }) {
    const value = await getGlobalEnv(args.name);
    if (value === undefined) {
      console.error(`no such env: ${args.name}`);
      process.exit(1);
    }
    console.log(value);
    return { name: args.name, value };
  },
});

const unsetSubcommand = defineCommand({
  meta: {
    name: "unset",
    description: "Remove a global env value.",
  },
  args: {
    name: { type: "positional", required: true, description: "Env name" },
  },
  async run({ args }) {
    const removed = await unsetGlobalEnv(args.name);
    if (!removed) {
      console.error(`no such env: ${args.name}`);
      process.exit(1);
    }
    console.log(`unset ${args.name}`);
    return { name: args.name };
  },
});

const listSubcommand = defineCommand({
  meta: {
    name: "list",
    description: "List all global env names (values not shown).",
  },
  async run() {
    const store = await listGlobalEnv();
    const names = Object.keys(store).toSorted();
    if (names.length === 0) {
      console.log("(no global env set)");
      return [];
    }
    for (const name of names) {
      console.log(name);
    }
    return names;
  },
});

export const envCommand = defineCommand({
  meta: {
    name: "env",
    description: "Manage the dither global env store at ~/.dither/env.json.",
  },
  subCommands: {
    set: setSubcommand,
    get: getSubcommand,
    unset: unsetSubcommand,
    list: listSubcommand,
  },
});
