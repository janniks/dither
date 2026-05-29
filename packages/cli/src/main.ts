import { defineCommand } from "citty";
import { searchCommand } from "./commands/command-search";
import { getCommand } from "./commands/command-get";
import { pluginCommand } from "./commands/command-plugin";
import { indexCommand } from "./commands/command-index";
import { statusCommand } from "./commands/command-status";
import { envCommand } from "./commands/command-env";
import { daemonCommand } from "./commands/command-daemon";
import { initCommand } from "./commands/command-init";
import { collectionCommand } from "./commands/command-collection";

export const main = defineCommand({
  meta: {
    name: "dither",
    version: "0.0.1",
    description: "Personal index for the agentic era.",
  },
  subCommands: {
    init: initCommand,
    search: searchCommand,
    get: getCommand,
    plugin: pluginCommand,
    env: envCommand,
    index: indexCommand,
    collection: collectionCommand,
    daemon: daemonCommand,
    status: statusCommand,
  },
});
