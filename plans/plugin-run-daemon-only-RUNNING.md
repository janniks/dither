# plugin-run-daemon-only — implementation plan

Spec: `specs/plugin-run-daemon-only.md`. Daemon becomes the sole plugin supervisor. CLI writes a kick, signals SIGUSR1, tails the journal.

Each phase ends with build + tests green; commit after each.

## Phase 1 — `kicks.ts` module + `signalDaemon` helper

Add a new module `packages/cli/src/kicks.ts` mirroring `refire.ts`:

- `KickPayload = { runId, kickedAt, overrides? }`
- `readKick(plugin)`, `writeKick(plugin, payload)`, `clearKick(plugin)`, `listKicks()`
- `signalDaemon()` — read pid file, `process.kill(pid, "SIGUSR1")`. ENOENT/ESRCH → no-op.

Acceptance:
- [x] `packages/cli/src/kicks.ts` exists and exports the four-fn IO API plus `signalDaemon`
- [x] Plugin-name safety mirrors `refire.ts:36-40`
- [x] New `packages/cli/src/kicks.test.ts` covers write+read roundtrip, clear, list, traversal rejection, and `signalDaemon` ENOENT
- [x] `npm run build` + tests pass

## Phase 2 — Daemon `scanKicks` + SIGUSR1 + `openRun` pre-supplied runId

Wire the kick mechanism into the daemon. Nothing writes kicks yet from the CLI.

- Add `openRun(plugin, trigger, runId?)` to `run-log.ts`. Optional `runId` is honored; daemon-side default still mints one via `generateRunId`.
- Export `generateRunId(plugin)` from `run-log.ts`.
- Add `Kicker` source in `daemon.ts` style — process one kick, fire via `fireWithSuppress`, clear file. Actually: spec says the SIGUSR1 handler calls `scanKicks()` directly (one `readdir` per signal, per-file: fire + unlink). Implement as a `scanKicks(fire)` function plus a startup-drain.
- Plumb `kickRunId` and `overrides` from kick payload into the fire path. `fireWithSuppress` accepts an optional `{ runId, overrides }` per call and passes to `runPlugin`.
- Daemon-side: on `SIGUSR1`, call `scanKicks`. On startup (right after `recoverOrphanInflight`), drain `kicks/` once.

Acceptance:
- [x] `openRun(plugin, trigger, runId?)` honors a pre-supplied id (tested)
- [x] `scanKicks(fire)` reads, fires via callback, unlinks each kick (tested with a fake fire callback)
- [x] SIGUSR1 handler installed in `runDaemon`
- [x] Startup drain invokes `scanKicks` once before reconcile (or alongside)
- [x] Build + targeted tests green

## Phase 3 — CLI `d plugin run X` switches to kick + tail

User-facing payoff. Delete old in-CLI supervision.

- `commands/plugin.ts` `runSubcommand`:
  - Auto-start daemon (via `ensureDaemon`-style call: probe → `startDaemon` if dead, else SIGHUP-or-noop).
  - Pre-check: kick file exists OR lock held → "X is already running — tail with 'dither plugin runs X'". Exit 1.
  - Mint `runId = generateRunId(plugin)`, write kick with overrides + runId, send SIGUSR1.
  - Default: tail `runId` via existing `tailRun(runId)`. Ctrl-c stops tailing only; print `(detached — still running, tail with 'dither plugin runs X')`.
  - `--detach` skips tail, prints `runId`, exits.
  - Delete `--verbose` flag, `onProgress` callback usage, old `--detach` re-spawn path, `PLUGIN_ALREADY_RUNNING` handling in CLI.
- Delete the `PLUGIN_ALREADY_RUNNING` constant + lock throw in `plugin-run.ts`.
- Delete `onProgress` + `verbose` from `RunOptions`.

Acceptance:
- [x] CLI no longer imports `runPlugin` from `plugin-run`
- [x] `--verbose` flag removed
- [x] `--detach` shrinks to "skip tail"
- [x] Lock pre-check + kick-file pre-check both reject duplicate fires cleanly
- [x] Build passes; `commands/plugin.test.ts` updated (or test scaffolding accommodates new flow)

## Phase 4 — Move lock acquisition into `fireWithSuppress`

`runPlugin` stops importing locks.

- `fireWithSuppress` calls `acquire(name)` before `runPlugin`, releases in `finally`.
- `runPlugin` removes the `acquireLock`/`releaseLock` import and the early-exit-on-null branch.
- `runPlugin` tests no longer need to manage lock state.

Acceptance:
- [x] `runPlugin` does not import `./locks`
- [x] All four fire sources (Scheduler, Watcher, Refirer, kick path) acquire the lock in one place
- [x] Build + tests pass

## Phase 5 — Extract `Supervisor` deep module

Move spawn + stderr handling + control-message parsing + FDA detection + childPid recording into `packages/cli/src/supervisor.ts`.

- Entry: `supervise({ pluginDir, runDir, denoArgs, env, journal, denoPath, pluginName }) → { exitCode, lastReschedule, fdaPath? }`
- Parses control messages, journals stderr, surfaces FDA path on EPERM.
- New `supervisor.test.ts` with fake `spawn`.

Acceptance:
- [x] `runPlugin` shrinks by ~120 lines
- [x] `supervisor.ts` covers argv composition + parsing + childPid + FDA
- [x] Tests green

## Phase 6 — Extract `Promotion` deep module

Move `planPromotion` + `copyAdded` + index-lock dance into `packages/cli/src/promotion.ts`.

- Entry: `promote({ runDir, plugin, config, grants, journal }) → { added, reindexDeferred }`.
- New `promotion.test.ts`.

Acceptance:
- [x] `runPlugin` reaches ~80-line orchestrator shape
- [x] Tests for valid promotion, source-mismatch, missing grant, index-lock-busy
- [x] Tests green

## Finalize

Rename `plans/plugin-run-daemon-only-RUNNING.md` → `plans/plugin-run-daemon-only.md` with any final edits in the same commit.

## Phase log

| commit | summary |
| --- | --- |
| d65ebcd | phase 1: kicks.ts module + signalDaemon, tests pinning I/O contract |
| 6daf364 | phase 2: daemon wires scanKicks + SIGUSR1 + startup drain, openRun honors presupplied runId |
| dae6ee8 | phase 3: CLI plugin run X kicks the daemon + tails; drops --verbose, onProgress, old --detach |
| a411c9a | phase 4: lock moves from runPlugin into fireWithSuppress |
| 9f81462 | phase 5: extract Supervisor (spawn + control parsing + FDA + childPid) |
| (phase6) | phase 6: extract Promotion (planPromotion + copyAdded + index-defer) |
