import { access } from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import { resolveHome } from "./home";
import { loadConfig } from "./config";
import { listPlugins } from "./plugin-list";
import { getDaemonStatus, type DaemonStatus } from "./daemon-control";
import { readJobsSnapshot, type JobsSnapshot } from "./daemon-jobs";
import { openStore } from "./store";

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
  let libraryHealth = await probeLibraryHealth(library);

  let collections: number | null = null;
  let entries: number | null = null;
  if (libraryHealth === "ok" && library) {
    try {
      const store = await openStore();
      const s = await store?.getStatus();
      collections = s?.collections.length ?? 0;
      entries = s?.totalDocuments ?? 0;
    } catch {
      // R_OK already passed, so the directory is readable — this catch only
      // fires when the qmd store itself won't open. In a real install that
      // basically can't happen, so we don't special-case it. It DOES show up
      // in dev checkouts: `~/.npmrc` sets `ignore-scripts=true`, so
      // better-sqlite3's native binding isn't built on `npm install` and
      // openStore throws "Could not locate the bindings file" until you run
      // `npm run install` inside node_modules/better-sqlite3. The "unreadable"
      // label is imperfect for that case but not worth a dedicated state.
      libraryHealth = "unreadable";
    }
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
