import { defineCommand } from "citty";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertInitialized, saveConfig } from "../config";
import { addExternal, loadRegistry, removeExternal } from "../collection-registry";
import { updateIndex } from "../update-index";

const addSubcommand = defineCommand({
  meta: {
    name: "add",
    description:
      "Register an existing folder as an external collection. The folder stays where it is; dither indexes and grants against it.",
  },
  args: {
    path: {
      type: "positional",
      required: true,
      description: "Filesystem path to the folder to register.",
    },
    name: {
      type: "string",
      description:
        "Collection name. Defaults to a slug of the folder's basename (e.g. 'Work Notes' → 'work-notes').",
    },
  },
  async run({ args }) {
    const cfg = await assertInitialized();
    const { cfg: next, entry } = addExternal(cfg, args.path, args.name);
    await saveConfig(next);
    // Index the new mount inline so the very next `dither search` sees
    // its contents. Failure here doesn't roll back the registration —
    // a stale index recovers on the next scheduled `index update`.
    try {
      await updateIndex([entry.name]);
    } catch (err) {
      console.warn(
        `[dither] indexed registration but inline reindex failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    console.log(`registered '${entry.name}' → ${entry.path}`);
  },
});

const listSubcommand = defineCommand({
  meta: {
    name: "list",
    description: "List every known collection (library subdirs + externals).",
  },
  args: {
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Include on-disk path and file count for each entry.",
      default: false,
    },
  },
  async run({ args }) {
    const cfg = await assertInitialized();
    const collections = loadRegistry(cfg);
    if (collections.length === 0) {
      console.log("(no collections)");
      return;
    }
    for (const c of collections) {
      const missing = c.status === "missing" ? " (missing)" : "";
      if (args.verbose) {
        const count = c.status === "ok" ? countMd(c.path) : "?";
        console.log(
          `${c.name.padEnd(20)} ${c.source.padEnd(8)} ${count
            .toString()
            .padStart(5)} md  ${c.path}${missing}`,
        );
      } else {
        console.log(`${c.name.padEnd(20)} ${c.source}${missing}`);
      }
    }
  },
});

const removeSubcommand = defineCommand({
  meta: {
    name: "remove",
    description:
      "Unregister an external collection. Files on disk are NOT deleted; only the registry entry is dropped.",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Name of the external collection to unregister.",
    },
  },
  async run({ args }) {
    const cfg = await assertInitialized();
    const next = removeExternal(cfg, args.name);
    await saveConfig(next);
    // Drop this collection's rows from the index. Reopen the store with
    // the new registry; qmd's update over the remaining collections will
    // not re-touch the removed one.
    try {
      await updateIndex();
    } catch (err) {
      console.warn(
        `[dither] unregistered but index refresh failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    console.log(`unregistered '${args.name}'`);
  },
});

export const collectionCommand = defineCommand({
  meta: {
    name: "collection",
    description: "Manage collections (library subdirs + external mounts).",
  },
  subCommands: {
    add: addSubcommand,
    list: listSubcommand,
    remove: removeSubcommand,
  },
});

function countMd(path: string): number {
  let count = 0;
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) count++;
    }
  };
  try {
    if (statSync(path).isDirectory()) walk(path);
  } catch {
    // ignore — caller decides what to print
  }
  return count;
}
