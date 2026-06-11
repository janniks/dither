import { defineCommand } from "citty";
import { reloadDaemon } from "../daemon-control";
import { isInstalled, removePlugin } from "../plugin-remove";

export const removeSubcommand = defineCommand({
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
    if (!isInstalled(args.name)) {
      process.stderr.write(`error: plugin not installed: '${args.name}'\n`);
      process.stderr.write(`hint: run 'dither plugin list' to see installed plugins.\n`);
      process.exit(1);
    }
    await removePlugin({ name: args.name });
    console.log(`removed ${args.name}`);
    await reloadDaemon().catch(() => {});
    return { name: args.name };
  },
});
