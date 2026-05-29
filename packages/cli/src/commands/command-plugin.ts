import { defineCommand } from "citty";
import { installSubcommand } from "./command-plugin-install";
import { runSubcommand } from "./command-plugin-run";
import { runsSubcommand } from "./command-plugin-runs";
import { listSubcommand } from "./command-plugin-list";
import { removeSubcommand } from "./command-plugin-remove";
import { oauthSubcommand } from "./command-plugin-oauth";

/**
 * `dither plugin` dispatcher. Each subcommand lives in its own file
 * (`command-plugin-<name>.ts`); shared helpers live in
 * `command-plugin-shared.ts`. Adding a new subcommand = new file +
 * one line in the map below.
 */
export const pluginCommand = defineCommand({
  meta: {
    name: "plugin",
    description: "Manage plugins.",
  },
  subCommands: {
    install: installSubcommand,
    run: runSubcommand,
    runs: runsSubcommand,
    list: listSubcommand,
    remove: removeSubcommand,
    oauth: oauthSubcommand,
  },
});
