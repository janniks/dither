import { defineCommand } from "citty";
import { searchCommand } from "./commands/search";
import { getCommand } from "./commands/get";
import { pluginCommand } from "./commands/plugin";
import { indexCommand } from "./commands/index";
import { statusCommand } from "./commands/status";
import { envCommand } from "./commands/env";
import { daemonCommand } from "./commands/daemon";
import { initCommand } from "./commands/init";
import { collectionCommand } from "./commands/collection";

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
