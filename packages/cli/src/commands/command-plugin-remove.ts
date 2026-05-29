import { defineCommand } from "citty";
import { reloadDaemon } from "../daemon-control";
import { removePlugin } from "../plugin-remove";

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
    await removePlugin({ name: args.name });
    console.log(`removed ${args.name}`);
    await reloadDaemon().catch(() => {});
    return { name: args.name };
  },
});
