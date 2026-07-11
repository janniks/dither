import { defineCommand } from "citty";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertInitialized, saveConfig } from "../config";
import { addExternal, loadRegistry, removeExternal } from "../collection-registry";
import { reindex } from "../update-index";
import { printTable } from "../prompt";

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
    // its contents. Registration never rolls back — busy/failed rescans
    // defer to the daemon.
    await reindex([entry.name]);
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
      description: "Also show the on-disk path for each entry.",
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
    const rows = collections.map((c) => {
      const count = c.status === "ok" ? `${countMd(c.path)} md` : "? md";
      const src = c.status === "missing" ? `${c.source} (missing)` : c.source;
      return args.verbose ? [c.name, count, src, c.path] : [c.name, count, src];
    });
    const cols = args.verbose
      ? [{}, { align: "right" as const }, {}, {}]
      : [{}, { align: "right" as const }, {}];
    printTable(rows, cols);
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
    await reindex();
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
