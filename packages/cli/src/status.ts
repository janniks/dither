import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./home";
import { loadConfig } from "./config";
import { listPlugins } from "./plugin-list";
import { getDaemonStatus, type DaemonStatus } from "./daemon-control";

/**
 * Status surfaces the two location concepts separately:
 *   - configDir: dither's working directory (config, grants, indexes,
 *     plugin code, runs). Sourced from $DITHER_DIR / $XDG_CONFIG_HOME /
 *     ~/.dither.
 *   - library: the user's content (markdown entries). Sourced from
 *     config.library.path, set at `dither init --library`.
 *
 * `home` is retained as a deprecated alias of `configDir` for one
 * release so external consumers (`dither status --json` parsers) get a
 * grace window to migrate.
 */
export interface DitherStatus {
  configDir: string;
  library: string | null;
  /** @deprecated Use `configDir`. Retained for one release. */
  home: string;
  plugins: number;
  collections: number;
  entries: number;
  daemon: DaemonStatus;
}

async function countMarkdownEntries(root: string): Promise<{
  collections: number;
  entries: number;
}> {
  if (!existsSync(root)) return { collections: 0, entries: 0 };

  const top = await readdir(root);
  let collections = 0;
  let entries = 0;
  for (const name of top) {
    const path = join(root, name);
    const s = await stat(path);
    if (!s.isDirectory()) continue;
    collections += 1;
    entries += await countMarkdownDeep(path);
  }
  return { collections, entries };
}

async function countMarkdownDeep(dir: string): Promise<number> {
  let n = 0;
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const s = await stat(path);
    if (s.isDirectory()) {
      n += await countMarkdownDeep(path);
    } else if (name.endsWith(".md")) {
      n += 1;
    }
  }
  return n;
}

export async function getStatus(): Promise<DitherStatus> {
  const configDir = resolveHome();
  const plugins = (await listPlugins()).length;
  const cfg = await loadConfig();
  const library = cfg ? cfg.library.path : null;
  const { collections, entries } = library
    ? await countMarkdownEntries(library)
    : { collections: 0, entries: 0 };
  const daemon = await getDaemonStatus();
  return {
    configDir,
    library,
    home: configDir,
    plugins,
    collections,
    entries,
    daemon,
  };
}
