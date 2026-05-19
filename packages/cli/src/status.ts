import { readdir, stat, access } from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./home";
import { loadConfig } from "./config";
import { listPlugins } from "./plugin-list";
import { getDaemonStatus, type DaemonStatus } from "./daemon-control";
import { readJobsSnapshot, type JobsSnapshot } from "./daemon-jobs";

/**
 * Status surfaces the two location concepts separately:
 *   - configDir: dither's working directory (config, grants, indexes,
 *     plugin code, runs). Sourced from $DITHER_DIR / $XDG_CONFIG_HOME /
 *     ~/.dither.
 *   - library: the user's content (markdown entries). Sourced from
 *     config.library.path, set at `dither init --library`.
 *
 * `libraryHealth` distinguishes "library is healthy" from
 * "library is unconfigured / missing on disk / unreadable" so callers
 * (humans + agentic consumers) can tell unknowable counts (`null`)
 * apart from genuinely-zero counts.
 *
 * `configDirSource` mirrors home.ts's resolver chain so the human
 * printer can decide whether to show a `DITHER_DIR=/path` header.
 *
 * `home` is retained as a deprecated alias of `configDir` for one
 * release.
 */
export type LibraryHealth = "ok" | "missing" | "unreadable" | "unconfigured";
export type ConfigDirSource = "env" | "xdg" | "fallback";

export interface DitherStatus {
  configDir: string;
  configDirSource: ConfigDirSource;
  library: string | null;
  libraryHealth: LibraryHealth;
  /** @deprecated Use `configDir`. Retained for one release. */
  home: string;
  plugins: number;
  collections: number | null;
  entries: number | null;
  daemon: DaemonStatus;
  /**
   * Snapshot of qmd-mutating job state, sourced from the events log
   * cross-checked against live lock holders. Includes deferred-work
   * markers so the user sees pending reindex / cancelled-embed state.
   */
  jobs: JobsSnapshot;
}

async function countMarkdownEntries(root: string): Promise<{
  collections: number;
  entries: number;
}> {
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

/**
 * Detect which env (or none) drove resolveHome()'s decision. Mirrors
 * the chain in home.ts. Both `DITHER_DIR` (current) and `DITHER_HOME`
 * (legacy alias) count as `"env"` — the user is being explicit either
 * way.
 */
function detectConfigDirSource(): ConfigDirSource {
  if (process.env.DITHER_DIR || process.env.DITHER_HOME) return "env";
  if (process.env.XDG_CONFIG_HOME) return "xdg";
  return "fallback";
}

/**
 * Probe `library.path` for health. Cheap: one `existsSync` and at most
 * one `access(R_OK)`. Returns null when not configured at all.
 */
async function probeLibraryHealth(libraryPath: string | null): Promise<LibraryHealth> {
  if (!libraryPath) return "unconfigured";
  if (!existsSync(libraryPath)) return "missing";
  try {
    await access(libraryPath, constants.R_OK);
    return "ok";
  } catch {
    return "unreadable";
  }
}

export async function getStatus(): Promise<DitherStatus> {
  const configDir = resolveHome();
  const configDirSource = detectConfigDirSource();
  const plugins = (await listPlugins()).length;
  const cfg = await loadConfig();
  const library = cfg ? cfg.library.path : null;
  const libraryHealth = await probeLibraryHealth(library);

  let collections: number | null = null;
  let entries: number | null = null;
  if (libraryHealth === "ok" && library) {
    const counts = await countMarkdownEntries(library);
    collections = counts.collections;
    entries = counts.entries;
  }

  const daemon = await getDaemonStatus();
  const jobs = await readJobsSnapshot();
  return {
    configDir,
    configDirSource,
    library,
    libraryHealth,
    home: configDir,
    plugins,
    collections,
    entries,
    daemon,
    jobs,
  };
}
