import { defineCommand } from "citty";
import { searchCommand } from "./commands/search";
import { getCommand } from "./commands/get";
import { pluginCommand } from "./commands/plugin";
import { indexCommand } from "./commands/index";
import { statusCommand } from "./commands/status";

export const main = defineCommand({
  meta: {
    name: "dither",
    version: "0.0.1",
    description: "Personal index for the agentic era.",
  },
  subCommands: {
    search: searchCommand,
    get: getCommand,
    plugin: pluginCommand,
    index: indexCommand,
    status: statusCommand,
  },
});
