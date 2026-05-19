import { mkdir, readFile, writeFile, readdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { resolveHome } from "./home";
import { assertInitialized, type DitherConfig } from "./config";
import { parsePackage } from "./manifest";
import { updateIndex } from "./update-index";
import { needsReindexPath } from "./daemon-jobs";
import { tryAcquireQmdLock, releaseQmdLock } from "./qmd-locks";
import { getGlobalEnv } from "./global-env";
import { validateCollectionPath, validateGrantPattern, grantsCover } from "./collection-paths";
import { resolveCollection } from "./collection-registry";
import { acquire as acquireLock, release as releaseLock } from "./locks";
import { startRun, type RunJournal } from "./journal";
import { isMacOS, findProtectedPathInError, formatFdaError, FDA_REQUIRED } from "./tcc-hint";
import { ensureDeno } from "./deno-bootstrap";
import { claimInbox, clearInflight, restoreInflight, type WatchTarget } from "./inbox";
import { clearRefire, decideRunOutcome, readRefire, writeRefire } from "./refire";
import { resolveWatchPath } from "./watch-paths";
import { libraryRoot as resolveLibraryRoot } from "./paths";

export interface ProgressMessage {
  message: string;
  done?: number;
  total?: number;
}

export interface RunOptions {
  name: string;
  trigger?: "scheduled" | "watch" | "manual";
  /** Per-run env literal overrides. Layered on top of grants for this run only. */
  env?: Record<string, string>;
  /** Per-run env-grant additions. Layered on top of grants for this run only. */
  envRefs?: string[];
  /** Per-run file overrides. Each path is added to --allow-read. */
  files?: Record<string, string>;
  /** Per-run net additions. Layered on top of grants for this run only. */
  net?: string[];
  /** Per-run collection grant additions. */
  collections?: string[];
  /** Files that triggered this run. Surfaced in input.json.targets. Watch
   *  fires usually leave this unset — the runner claims the inbox itself. */
  targets?: WatchTarget[];
  /** Called for every `progress()` NDJSON message the plugin emits on stderr. */
  onProgress?: (msg: ProgressMessage) => void;
  /** Forward plugin stderr (Deno output, console.log/error) to the host's stderr in real time. */
  verbose?: boolean;
}

export interface RunResult {
  runId: string;
  promoted: string[];
}

/** Error code stamped on errors that signal a known, clean failure path. */
export const PLUGIN_NOT_INSTALLED = "PLUGIN_NOT_INSTALLED";

const DITHER_ENV_VARS = [
  "DITHER_RUN_DIR",
  "DITHER_INPUT_FILE",
  "DITHER_STATE_FILE",
  "DITHER_TRIGGER",
  "DITHER_PLUGIN_NAME",
];

interface GrantsFile {
  env?: Record<string, string>;
  envRefs?: string[];
  files?: Record<string, string>;
  net?: string[];
  collections?: string[];
}

interface ParsedFrontmatter {
  source?: unknown;
  collection?: unknown;
}

interface RescheduleMessage {
  kind: "reschedule";
  afterMs: number;
  reason?: string;
}

type ControlMessage = (ProgressMessage & { kind: "progress" }) | RescheduleMessage;

function parseControl(line: string): ControlMessage | null {
  if (!line || line[0] !== "{") return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj._dither === "progress") {
      if (typeof obj.message !== "string") return null;
      return {
        kind: "progress",
        message: obj.message,
        done: typeof obj.done === "number" ? obj.done : undefined,
        total: typeof obj.total === "number" ? obj.total : undefined,
      };
    }
    if (obj._dither === "reschedule") {
      if (typeof obj.afterMs !== "number" || obj.afterMs <= 0) return null;
      return {
        kind: "reschedule",
        afterMs: obj.afterMs,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface PromoteCandidate {
  src: string;
  dest: string;
  collection: string;
  filename: string;
}

async function planPromotion(
  runDir: string,
  pluginName: string,
  cfg: DitherConfig,
  allowedCollections: readonly string[],
): Promise<PromoteCandidate[]> {
  const entries = await readdir(runDir);
  const out: PromoteCandidate[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(".md")) continue;
    const src = join(runDir, filename);
    const content = await readFile(src, "utf-8");
    const data = matter(content).data as ParsedFrontmatter;

    const source = typeof data.source === "string" ? data.source : null;
    if (source !== pluginName) {
      throw new Error(
        `output ${filename} declares source=${source ?? "(missing)"}; expected ${pluginName}`,
      );
    }
    const collection = typeof data.collection === "string" ? data.collection : null;
    if (!collection) {
      throw new Error(`output ${filename} missing 'collection' frontmatter`);
    }
    validateCollectionPath(collection);
    if (!grantsCover(allowedCollections, collection)) {
      throw new Error(
        `plugin '${pluginName}' is not granted write access to collection '${collection}'`,
      );
    }

    // Resolve the destination by top-segment lookup. External mounts win
    // when registered; otherwise the library auto-creates a subdir. The
    // qmd-side collection name is the top segment in either case (see
    // store.ts) so search and partial-reindex behave identically.
    const [top, ...rest] = collection.split("/");
    const resolved = resolveCollection(cfg, top!);
    let destDir: string;
    if (resolved?.source === "external") {
      if (resolved.status === "missing") {
        throw new Error(
          `output ${filename} targets external collection '${top}' but its path is missing: ${resolved.path}`,
        );
      }
      destDir = rest.length > 0 ? join(resolved.path, ...rest) : resolved.path;
    } else {
      destDir = join(cfg.library.path, collection);
    }
    const dest = join(destDir, filename);
    if (existsSync(dest)) {
      const existing = await readFile(dest, "utf-8");
      const existingSource = (matter(existing).data as ParsedFrontmatter).source;
      if (existingSource !== pluginName) {
        throw new Error(
          `output ${filename} would clobber an existing entry at '${collection}/${filename}' (source=${
            typeof existingSource === "string" ? existingSource : "(missing)"
          }, this plugin=${pluginName})`,
        );
      }
    }

    out.push({ src, dest, collection, filename });
  }
  return out;
}

async function copyPromoted(candidates: PromoteCandidate[]): Promise<string[]> {
  const promoted: string[] = [];
  for (const c of candidates) {
    await mkdir(join(c.dest, ".."), { recursive: true });
    await copyFile(c.src, c.dest);
    promoted.push(c.dest);
  }
  return promoted;
}

export async function runPlugin(opts: RunOptions): Promise<RunResult> {
  const home = resolveHome();
  const pluginDir = join(home, "plugins", opts.name);
  if (!existsSync(pluginDir)) {
    const err = new Error(`plugin not installed: '${opts.name}'`) as Error & { code: string };
    err.code = PLUGIN_NOT_INSTALLED;
    throw err;
  }

  // Single-arbiter check: only one run of this plugin at a time. Schedule,
  // watch, and manual fires all funnel through the same lock.
  const lock = await acquireLock(opts.name);
  if (!lock) {
    throw new Error(
      `Plugin '${opts.name}' is already running. Wait for it to finish, or check 'dither status'.`,
    );
  }

  const trigger = opts.trigger ?? "manual";
  const { journal, runId } = await startRun(opts.name, trigger);

  try {
    const { promoted, reschedule } = await runPluginLocked(
      opts,
      home,
      pluginDir,
      journal,
      runId,
      trigger,
    );

    // Decide what to do with inflight + refire row given the success outcome.
    const prior = await readRefire(opts.name).catch(() => null);
    const decision = decideRunOutcome({
      exitCode: 0,
      rescheduleMs: reschedule?.afterMs ?? null,
      ...(reschedule?.reason ? { rescheduleReason: reschedule.reason } : {}),
      prior,
    });

    if (decision.kind === "ok-cleared") {
      await clearInflight(opts.name).catch(() => {});
      await clearRefire(opts.name).catch(() => {});
    } else if (decision.kind === "ok-rescheduled") {
      // Keep inflight on disk — the refire will re-deliver these rows.
      await writeRefire(opts.name, decision.row);
    }

    await journal.close({
      status: "ok",
      finishedAt: new Date().toISOString(),
      promoted,
    });
    return { runId, promoted };
  } catch (err) {
    // At-least-once: any non-clean path returns inflight rows to the
    // inbox so a future fire picks them up. Includes thrown errors,
    // non-zero exits, and signal kills (all funnel through here).
    await restoreInflight(opts.name).catch(() => {});

    const exitCode = (err as { exitCode?: number }).exitCode ?? 1;
    const prior = await readRefire(opts.name).catch(() => null);
    const decision = decideRunOutcome({
      exitCode,
      rescheduleMs: null,
      prior,
    });
    if (decision.kind === "failed-retry" || decision.kind === "failed-suspended") {
      await writeRefire(opts.name, decision.row).catch(() => {});
    }

    const message = err instanceof Error ? err.message : String(err);
    await journal.append("error", { message }).catch(() => {});
    await journal
      .close({
        status: "fail",
        finishedAt: new Date().toISOString(),
        error: message,
        exitCode,
      })
      .catch(() => {});
    throw err;
  } finally {
    await releaseLock(lock);
  }
}

async function runPluginLocked(
  opts: RunOptions,
  home: string,
  pluginDir: string,
  journal: RunJournal,
  runId: string,
  trigger: string,
): Promise<{ promoted: string[]; reschedule: { afterMs: number; reason?: string } | null }> {
  const pkgRaw = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf-8")) as unknown;
  const parsed = parsePackage(pkgRaw);

  const grantsPath = join(home, "grants", `${opts.name}.json`);
  const grants: GrantsFile = existsSync(grantsPath)
    ? (JSON.parse(await readFile(grantsPath, "utf-8")) as GrantsFile)
    : {};

  // Layer per-run overrides on top of grants. Per-run additions are ephemeral —
  // they don't get written back to the grants file.
  const grantEnv = { ...grants.env, ...opts.env };
  const envRefs = Array.from(new Set([...(grants.envRefs ?? []), ...(opts.envRefs ?? [])]));
  const grantFiles = { ...grants.files, ...opts.files };
  const grantNet = Array.from(new Set([...(grants.net ?? []), ...(opts.net ?? [])]));
  const grantCollections = Array.from(
    new Set([...(grants.collections ?? []), ...(opts.collections ?? [])]),
  );
  for (const pattern of grantCollections) validateGrantPattern(pattern);

  const resolvedEnv: Record<string, string> = { ...grantEnv };
  for (const name of envRefs) {
    if (resolvedEnv[name] !== undefined) continue;
    const globalValue = await getGlobalEnv(name);
    if (globalValue !== undefined) resolvedEnv[name] = globalValue;
  }
  for (const def of parsed.manifest.env ?? []) {
    if (resolvedEnv[def.name] !== undefined) continue;
    if (def.default !== undefined) resolvedEnv[def.name] = def.default;
  }

  const runDir = join(home, "runs", runId);
  await mkdir(runDir, { recursive: true });

  try {
    const stateDir = join(pluginDir, "state");
    await mkdir(stateDir, { recursive: true });
    const stateFile = join(stateDir, "state.json");

    // Watch fires claim from the inbox; manual/scheduled use whatever the
    // caller passes (typically nothing). The inbox claim is what makes
    // backfill seeding (Phase 3) and daemon-driven watch dispatch share
    // one fire pipeline.
    const targets: WatchTarget[] =
      opts.targets ?? (trigger === "watch" ? await claimInbox(opts.name) : []);

    const inputFile = join(runDir, "input.json");
    await writeFile(
      inputFile,
      JSON.stringify(
        {
          trigger,
          env: resolvedEnv,
          files: grantFiles,
          targets,
        },
        null,
        2,
      ),
    );

    const sdkUrl = import.meta.resolve("@dither/plugin");
    const sdkPath = fileURLToPath(sdkUrl);
    const importMapPath = join(runDir, "_import-map.json");
    await writeFile(
      importMapPath,
      JSON.stringify({
        imports: { "@dither/plugin": sdkUrl },
      }),
    );

    // For watch plugins, grant read access to each watched collection root
    // (a directory) rather than enumerating every target path. With a
    // backfill spanning ~130k files, per-target paths blow past ARG_MAX
    // when joined into the `--allow-read=` argv. Directory grants cover
    // every file under them.
    const watchCollections = parsed.manifest.watch?.collections ?? [];
    const watchRoots = watchCollections.length > 0
      ? await Promise.all(
          watchCollections.map(async (c) => resolveWatchPath(await resolveLibraryRoot(), c)),
        )
      : [];

    const allowRead = [
      pluginDir,
      runDir,
      sdkPath,
      ...Object.values(grantFiles),
      ...watchRoots,
      // If watch roots cover the targets (the normal case for watch fires
      // and backfill), per-target paths are redundant. We still include
      // them for explicit-target callers (e.g. ad-hoc `runPlugin` use
      // outside the watch pipeline) but only when no watch roots exist.
      ...(watchRoots.length > 0 ? [] : targets.map((t) => t.path)),
    ].join(",");
    const allowWrite = [stateDir, runDir].join(",");
    const allowEnv = DITHER_ENV_VARS.join(",");

    const denoArgs = [
      "run",
      `--import-map=${importMapPath}`,
      `--allow-read=${allowRead}`,
      `--allow-write=${allowWrite}`,
      `--allow-env=${allowEnv}`,
    ];
    if (grantNet.length) {
      // Sole `"*"` entry → bare --allow-net (any host). Required by plugins
      // that fetch arbitrary URLs (e.g. URL scrapers); user opts in by
      // accepting `net: ["*"]` from the manifest at install time.
      if (grantNet.length === 1 && grantNet[0] === "*") {
        denoArgs.push("--allow-net");
      } else {
        denoArgs.push(`--allow-net=${grantNet.join(",")}`);
      }
    }
    denoArgs.push(join(pluginDir, "plugin.ts"));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DITHER_RUN_DIR: runDir,
      DITHER_INPUT_FILE: inputFile,
      DITHER_STATE_FILE: stateFile,
      DITHER_TRIGGER: trigger,
      DITHER_PLUGIN_NAME: opts.name,
    };

    // We sniff stderr only enough to (a) extract `progress()` control lines
    // and (b) detect FDA/EPERM on a protected path so we can throw an
    // error tagged `code: FDA_REQUIRED` with a clean hint. The full stream goes to the run
    // journal (`stderr` events). It is *not* mirrored to the host's stderr
    // unless `verbose` is set — otherwise Deno's coloured stack traces leak
    // into the user's terminal alongside the helpful headline.
    let sawProtectedEpermPath: string | null = null;
    let lastReschedule: { afterMs: number; reason?: string } | null = null;

    const denoPath = await ensureDeno();
    await new Promise<void>((res, rej) => {
      const child = spawn(denoPath, denoArgs, {
        env,
        stdio: ["inherit", "inherit", "pipe"],
      });
      let buf = "";
      child.stderr!.setEncoding("utf-8");
      const handleLine = (line: string): void => {
        const msg = parseControl(line);
        if (msg) {
          if (msg.kind === "progress") {
            void journal.append("progress", {
              message: msg.message,
              done: msg.done,
              total: msg.total,
            });
            if (opts.onProgress) {
              opts.onProgress({ message: msg.message, done: msg.done, total: msg.total });
            }
          } else {
            // Last reschedule wins if a plugin sends multiple. Journal each.
            lastReschedule = { afterMs: msg.afterMs, reason: msg.reason };
            void journal.append("reschedule", {
              afterMs: msg.afterMs,
              ...(msg.reason ? { reason: msg.reason } : {}),
            });
          }
          return;
        }
        void journal.append("stderr", { line });
        if (opts.verbose) process.stderr.write(`${line}\n`);
        if (isMacOS() && sawProtectedEpermPath === null && /PermissionDenied|EPERM/i.test(line)) {
          const path = findProtectedPathInError(line);
          if (path) sawProtectedEpermPath = path;
        }
      };
      child.stderr!.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handleLine(line);
        }
      });
      child.stderr!.on("end", () => {
        if (buf) handleLine(buf);
      });
      child.on("error", rej);
      child.on("exit", (code) => {
        if (code === 0) {
          res();
          return;
        }
        const message = sawProtectedEpermPath
          ? formatFdaError(sawProtectedEpermPath, denoPath)
          : `plugin '${opts.name}' exited with code ${code}`;
        const err = new Error(message) as Error & { exitCode: number; code?: string };
        err.exitCode = code ?? -1;
        if (sawProtectedEpermPath) err.code = FDA_REQUIRED;
        rej(err);
      });
    });

    // Two-pass promote: validate every output, then copy. Any validation
    // failure throws before any file is moved into the library, so a partial
    // promote is impossible. The full config is passed so promote-time
    // resolution can branch on external-collection mounts.
    const cfg = await assertInitialized();
    const candidates = await planPromotion(runDir, opts.name, cfg, grantCollections);
    const promoted = await copyPromoted(candidates);
    for (const path of promoted) {
      await journal.append("promoted", { path });
    }

    if (promoted.length > 0) {
      // qmd collections are top-level library subdirs (see store.ts), so a
      // multi-segment frontmatter `collection: "messages/inbox"` must be
      // narrowed to `"messages"` before being passed to updateIndex —
      // otherwise qmd's exact-name filter matches nothing and the index
      // silently stays stale.
      const touchedCollections = Array.from(
        new Set(candidates.map((c) => c.collection.split("/")[0]!)),
      );
      // qmd-index.lock coordinates with the daemon's job runner; if
      // it's busy (daemon is mid-indexing), defer by touching
      // needs-reindex so the daemon coalesces this into its next
      // post-job reconciliation. Promoted files are already on disk —
      // only the rescan is deferred.
      const indexLock = await tryAcquireQmdLock("index");
      if (indexLock.busy) {
        await writeFile(needsReindexPath(), "", "utf-8").catch(() => undefined);
      } else {
        try {
          await updateIndex(touchedCollections);
        } finally {
          await releaseQmdLock(indexLock);
        }
      }
    }

    return { promoted, reschedule: lastReschedule };
  } finally {
    // Always clean up the run dir — failed runs would otherwise leave
    // input.json (containing plaintext env values, possibly secrets) on disk.
    await rm(runDir, { recursive: true, force: true });
  }
}
