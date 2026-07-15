import { mkdir, readFile, writeFile, copyFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginDir as pluginDirOf, configDir } from "./paths";
import { assertInitialized, libraryRoot as resolveLibraryRoot } from "./config";
import { parsePackage } from "./manifest";
import { getGlobalEnv } from "./global-env";
import { readGrants, validateGrantPattern } from "./grants";
import { openRun, type RunHandle } from "./run-log";
import { formatFdaError, FDA_REQUIRED } from "./tcc-hint";
import { ensureDeno } from "./deno-bootstrap";
import { claimInbox, clearInflight, restoreInflight, type WatchTarget } from "./inbox";
import { clearRefire, decideRunOutcome, readRefire, writeRefire } from "./refire";
import { supervise } from "./supervisor";
import type { spawn as nodeSpawn } from "node:child_process";
import { promote } from "./promotion";
import { resolveWatchPath } from "./watch-paths";

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
  /** Per-run create-grant additions. */
  create?: string[];
  /** Per-run edit-grant additions (overwrite other plugins' entries). */
  edit?: string[];
  /** Files that triggered this run. Surfaced in input.json.targets. Watch
   *  fires usually leave this unset — the runner claims the inbox itself. */
  targets?: WatchTarget[];
  /** Pre-supplied runId. The kick path uses this so the CLI's tail can
   *  follow the journal before the daemon opens it. */
  runId?: string;
  /** Injectable spawn for tests. Defaults to node:child_process spawn. */
  spawn?: typeof nodeSpawn;
}

export interface RunResult {
  runId: string;
  added: string[];
}

/** Error code stamped on errors that signal a known, clean failure path. */
export const PLUGIN_NOT_INSTALLED = "PLUGIN_NOT_INSTALLED";

function denoPermissionList(kind: string, entries: string[]): string {
  const entry = entries.find((e) => e.includes(","));
  if (entry) {
    throw new Error(
      `cannot run plugin: Deno ${kind} permission entry contains an unsupported comma: ${entry}`,
    );
  }
  return entries.join(",");
}

export async function runPlugin(opts: RunOptions): Promise<RunResult> {
  const dir = configDir();
  const pluginDir = pluginDirOf(opts.name);
  if (!existsSync(pluginDir)) {
    const err = new Error(`plugin not installed: '${opts.name}'`) as Error & { code: string };
    err.code = PLUGIN_NOT_INSTALLED;
    throw err;
  }

  // The per-plugin lock used to live here but moved into the daemon's
  // `fireWithSuppress` — the lock is the daemon's invariant, and the
  // daemon is the only production caller. Tests can still call runPlugin
  // directly (story 10); two concurrent test runs would race the on-disk
  // state, but that's a test-author concern.

  const trigger = opts.trigger ?? "manual";
  const journal = await openRun(opts.name, trigger, opts.runId);
  const runId = journal.runId;

  try {
    const { added, reschedule } = await runPluginLocked(
      opts,
      dir,
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
      added,
    });
    return { runId, added };
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
    await journal.append({ kind: "error", message }).catch(() => {});
    await journal
      .close({
        status: "fail",
        finishedAt: new Date().toISOString(),
        error: message,
        exitCode,
      })
      .catch(() => {});
    throw err;
  }
}

export interface PlanArgs {
  name: string;
  trigger: string;
  pluginDir: string;
  runDir: string;
  sdkPath: string;
  importMapPath: string;
  inputFile: string;
  stateFile: string;
  /** Grants+overrides+globals+manifest-defaults, already resolved. */
  resolvedEnv: Record<string, string>;
  grantFiles: Record<string, string>;
  grantNet: string[];
  /** Watched collection roots (directories). When present they cover every
   *  target file, so per-target read grants are skipped — a ~130k-file
   *  backfill would otherwise blow past ARG_MAX in `--allow-read=`. */
  watchRoots: string[];
  targets: WatchTarget[];
}

export interface SpawnPlan {
  denoArgs: string[];
  env: NodeJS.ProcessEnv;
  input: {
    trigger: string;
    env: Record<string, string>;
    files: Record<string, string>;
    targets: WatchTarget[];
    net: string[];
  };
}

/**
 * The pure half of a plugin run: everything the Deno child receives —
 * argv permissions, env, input.json body — computed from already-resolved
 * data. No I/O; the permission matrix is testable with plain objects.
 *
 * The DITHER_* contract lives in ONE record here: `--allow-env` is derived
 * from its keys, so the allow-list and the values can't diverge (a var
 * added to one but not the other used to surface as a silent
 * PermissionDenied inside the child).
 */
export function plan(args: PlanArgs): SpawnPlan {
  const dither = {
    DITHER_RUN_DIR: args.runDir,
    DITHER_INPUT_FILE: args.inputFile,
    DITHER_STATE_FILE: args.stateFile,
    DITHER_TRIGGER: args.trigger,
    DITHER_PLUGIN_NAME: args.name,
  };

  const allowRead = denoPermissionList("read", [
    args.pluginDir,
    args.runDir,
    args.sdkPath,
    ...Object.values(args.grantFiles),
    ...args.watchRoots,
    // Watch roots cover the targets (the normal case for watch fires and
    // backfill); per-target paths only matter for explicit-target callers
    // outside the watch pipeline.
    ...(args.watchRoots.length > 0 ? [] : args.targets.map((t) => t.path)),
  ]);
  const denoArgs = [
    "run",
    `--import-map=${args.importMapPath}`,
    `--allow-read=${allowRead}`,
    // Write grant is runDir only — the plugin writes its state to the
    // run-local copy (under runDir), never the persistent state/ path.
    `--allow-write=${denoPermissionList("write", [args.runDir])}`,
    `--allow-env=${Object.keys(dither).join(",")}`,
  ];
  if (args.grantNet.length) {
    // Sole `"*"` entry → bare --allow-net (any host). Required by plugins
    // that fetch arbitrary URLs (e.g. URL scrapers); user opts in by
    // accepting `net: ["*"]` from the manifest at install time.
    if (args.grantNet.length === 1 && args.grantNet[0] === "*") {
      denoArgs.push("--allow-net");
    } else {
      denoArgs.push(`--allow-net=${denoPermissionList("net", args.grantNet)}`);
    }
  }
  denoArgs.push(join(args.pluginDir, "plugin.ts"));

  return {
    denoArgs,
    env: { ...process.env, ...dither },
    input: {
      trigger: args.trigger,
      env: args.resolvedEnv,
      files: args.grantFiles,
      targets: args.targets,
      net: args.grantNet,
    },
  };
}

async function runPluginLocked(
  opts: RunOptions,
  dir: string,
  pluginDir: string,
  journal: RunHandle,
  runId: string,
  trigger: string,
): Promise<{ added: string[]; reschedule: { afterMs: number; reason?: string } | null }> {
  const pkgRaw = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf-8")) as unknown;
  const parsed = parsePackage(pkgRaw);

  // Missing grants (e.g. a dev-symlinked plugin run before install) layer
  // as all-empty; per-run overrides below still apply.
  const grants = (await readGrants(opts.name)) ?? { name: opts.name, net: [], create: [], edit: [] };

  // Layer per-run overrides on top of grants. Per-run additions are ephemeral —
  // they don't get written back to the grants file.
  const grantEnv = { ...grants.env, ...opts.env };
  const envRefs = Array.from(new Set([...(grants.envRefs ?? []), ...(opts.envRefs ?? [])]));
  const grantFiles = { ...grants.files, ...opts.files };
  const grantNet = Array.from(new Set([...(grants.net ?? []), ...(opts.net ?? [])]));
  const creates = Array.from(
    new Set([...(grants.create ?? []), ...(opts.create ?? [])]),
  );
  const edits = Array.from(new Set([...(grants.edit ?? []), ...(opts.edit ?? [])]));
  for (const pattern of [...creates, ...edits]) validateGrantPattern(pattern);

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

  const runDir = join(dir, "runs", runId);
  await mkdir(runDir, { recursive: true });

  try {
    // State is transactional: the plugin reads/writes a run-local copy,
    // which only commits to the persistent path on a clean finish (next
    // to promotion). The committed state seeds the run-local copy; if no
    // committed state exists the run-local file starts absent (the SDK's
    // readState returns its initial). On interruption the run dir is
    // rm-rf'd, so the mutated copy vanishes and committed state is untouched.
    const stateDir = join(pluginDir, "state");
    await mkdir(stateDir, { recursive: true });
    const committedState = join(stateDir, "state.json");
    const stateFile = join(runDir, "state.json");
    await copyFile(committedState, stateFile).catch(() => undefined);

    // Watch fires claim from the inbox; manual/scheduled use whatever the
    // caller passes (typically nothing). The inbox claim is what makes
    // backfill seeding (Phase 3) and daemon-driven watch dispatch share
    // one fire pipeline.
    const targets: WatchTarget[] =
      opts.targets ?? (trigger === "watch" ? await claimInbox(opts.name) : []);

    const sdkUrl = import.meta.resolve("@dither/plugin");
    const importMapPath = join(runDir, "_import-map.json");
    await writeFile(
      importMapPath,
      JSON.stringify({
        imports: { "@dither/plugin": sdkUrl },
      }),
    );

    const watchCollections = parsed.manifest.watch?.collections ?? [];
    const spawnPlan = plan({
      name: opts.name,
      trigger,
      pluginDir,
      runDir,
      sdkPath: fileURLToPath(sdkUrl),
      importMapPath,
      inputFile: join(runDir, "input.json"),
      stateFile,
      resolvedEnv,
      grantFiles,
      grantNet,
      watchRoots:
        watchCollections.length > 0
          ? await Promise.all(
              watchCollections.map(async (c) => resolveWatchPath(await resolveLibraryRoot(), c)),
            )
          : [],
      targets,
    });
    await writeFile(join(runDir, "input.json"), JSON.stringify(spawnPlan.input, null, 2));

    // Spawn + stderr handling + control-message parsing live in
    // `supervisor.ts`. The supervisor returns the exit code (no throw);
    // we translate non-zero into the same FDA-tagged error the old
    // inline path raised.
    // An injected spawn (tests) drives the child directly, so the real
    // deno binary is never invoked — skip the bootstrap fetch.
    const denoPath = opts.spawn ? "deno" : await ensureDeno();
    const sup = await supervise({
      denoPath,
      denoArgs: spawnPlan.denoArgs,
      env: spawnPlan.env,
      journal,
      ...(opts.spawn ? { spawn: opts.spawn } : {}),
    });
    if (sup.exitCode !== 0) {
      const message = sup.fdaPath
        ? formatFdaError(sup.fdaPath, denoPath)
        : `plugin '${opts.name}' exited with code ${sup.exitCode}`;
      const err = new Error(message) as Error & { exitCode: number; code?: string };
      err.exitCode = sup.exitCode;
      if (sup.fdaPath) err.code = FDA_REQUIRED;
      throw err;
    }
    const cfg = await assertInitialized();
    const result = await promote({
      runDir,
      plugin: opts.name,
      config: cfg,
      grants: creates,
      edits,
      journal,
    });
    // Commit run-local state alongside promotion, under the same
    // clean-exit condition. tmp+rename keeps it atomic against a reader.
    // Only commit when the plugin actually wrote state this run.
    if (existsSync(stateFile)) {
      const tmp = join(stateDir, `.commit.${runId}.tmp`);
      await copyFile(stateFile, tmp);
      await rename(tmp, committedState);
    }
    return { added: result.added, reschedule: sup.lastReschedule };
  } finally {
    // Always clean up the run dir — failed runs would otherwise leave
    // input.json (containing plaintext env values, possibly secrets) on disk.
    await rm(runDir, { recursive: true, force: true });
  }
}
