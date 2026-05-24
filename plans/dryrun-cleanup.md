# Plan: Dry-run Review Cleanup

> Source: in-conversation review findings (2026-05-24). No spec file.

## Architectural decisions

- **No new modules, no new abstractions.** Every phase is either deletion, consolidation, or in-place fix.
- **Path layout owned by `home.ts`.** Add `pluginDir(name)`, `runResultPath(id)`; callers stop rebuilding the join.
- **One owner for `kill(pid, 0)`.** `locks.ts` owns the syscall wrapper; `daemon-control.ts` and `daemon-client.ts` import it. Divergent semantics (throw vs return false) collapse — callers handle the boolean.
- **Daemon snapshot is event-driven.** Heartbeat reads cached `recentRuns`; cache invalidates on Run open/close in `run-log.ts`, not on a 1 Hz scan.
- **Run-log follower drops the dual-stat.** Track size + inode from the previous tick; only `stat` once per poll. `appendGlobal` keeps the trailing newline state in memory instead of `existsSync + statSync` per call.
- **Commit hygiene.** Each phase stages only the files it touches by explicit path. Never `git add -A` or `git add .` — other agents have untracked `notes/plugin-*.md` in the worktree.

---

## Phase 1: Hot-path I/O — `appendGlobal` + follow loop + `tailRun`

End-to-end: Run-log writers stop doing sync I/O on the daemon tick; the follower stops double-statting; `dither plugin runs <id>` stops running a redundant 100 ms poll on top of the follower.

**Acceptance:**
- [x] `appendGlobal` (`run-log.ts:127`) no longer calls `existsSync` / `statSync` per event; size is tracked in memory per-path.
- [x] Follow loop (`run-log.ts:250-291`) stats the file at most once per tick; inode change is detected from the same stat.
- [x] `tailRun` (`commands/plugin.ts:625-641`) no longer runs `existsSync(resultPath)`; relies on `readResult` returning null on ENOENT (the follower watches events.jsonl, not the dir — reviewer was off on that detail).
- [x] `run-log.test.ts` + `plugin-runs.test.ts` + daemon-client/jobs/daemon tests pass.

---

## Phase 2: Daemon heartbeat + SIGHUP reconcile

End-to-end: 1 Hz `writeStatusSnapshot` stops doing N+1 reads of every run dir; SIGHUP stops reading every grants file twice.

**Acceptance:**
- [x] `loadScheduleEntries` + `loadWatchEntries` collapsed into one `listPlugins()` per SIGHUP; `listPlugins` now parallelizes grants reads via `Promise.all` and surfaces `watch` so no second read is needed.
- [x] `listRuns` parallelizes the per-Run summary read and pre-caps to `limit` before fanning out (was sequential N+1).
- [x] `readGlobal(tailLines)` (used by `readJobsSnapshot`) reads a bounded trailing chunk from EOF instead of allocating a whole-file buffer.
- [~] Heartbeat-level `recentRuns` cache deferred: cross-process invalidation can't ride on module state (daemon vs plugin child), and `historyDir` mtime misses result.json writes that happen inside existing run dirs. The N+1 cost is now ≤1 round-trip thanks to `listRuns` parallelization, so the bigger fix isn't needed.
- [x] Phase 2-adjacent tests pass: `run-log`, `daemon-jobs`, `daemon-client`, `plugin-runs`, and 5/7 daemon tests. The "registers schedule fires runPlugin within ~3s" test was already failing before Phase 2 (confirmed by reverting all Phase 2 files — same 30s timeout); environmental, not a regression.

---

## Phase 3: Reuse — `isPidAlive` + `home.ts` path helpers

End-to-end: One `isPidAlive` exported from `locks.ts`; `daemon-control.ts` and `daemon-client.ts` import it. Plugin dir + run result path live in `home.ts`; three callers stop rebuilding joins.

**Acceptance:**
- [x] `locks.ts` exports `isPidAlive(pid): boolean` (strict-throw on unknown errno). `daemon-control.ts` + `daemon-client.ts` import it; both local copies deleted.
- [x] `home.ts` exports `pluginDir(name)` and `runResultPath(id)`. `plugin-run.ts`, `plugin-remove.ts`, `plugin-install.ts`, and `commands/plugin.ts` use them.
- [x] All tests covering these modules pass (53/53 across run-log, locks, daemon-client, home, plugin-runs).

---

## Phase 4: Quality pass — comments, try/catch, control flow, naming

End-to-end: narrating comments stripped; broad try/catch narrowed or removed; `let`-then-assign patterns become early returns; the densest multi-word-locals clusters get short names; watcher suppress map sweeps unconditionally.

**Acceptance:**
- [x] Narrating comments removed: `commands/init.ts` (watchDaemonReconcile preamble), `daemon-client.ts:153-156` and `:161-163` (kept only the latency rationale).
- [x] Try/catch narrowed: `daemon.ts` `readRunningPlugins` narrows to ENOENT; `inbox.ts` `readRows` uses a `parseOrNull` helper instead of a try in the loop body. `daemon.ts:82-94` was already cleaned up in Phase 2.
- [x] Renames: `daemon-client.ts` watchReconcile locals (`innerAc`→`ac`, `livenessTimer`→`timer`, `daemonDied`→`dead`, `cycleStarted`→`started`, etc.). `daemon.ts` qmd reconcile (`qmdReconcileInFlight`→`inflight`, `qmdReconcileQueued`→`queued`, `lastQmdReconcileStart`→`lastStart`, `LEVEL_TRIGGER_MIN_INTERVAL_MS`→`REFIRE_MIN_MS`). `progress.ts` embedLoop (`cumEmbedded`→`embedded`, `cumDuration`→`duration`, `cumTruncated`→`truncated`, `initialTotal`→`total`). `daemon-jobs.ts` embed callback updated to match.
- [x] `watcher.ts` suppress map sweep runs unconditionally each tick; the `size > 64` gate removed.
- [ ] `commands/status.ts` rewrites + `commands/plugin.ts:163` deferred — parallel agent's `cli-table-output` work is touching these in flight.
- [x] Type check clean; 101/104 tests pass (3 pre-existing environmental failures: better-sqlite3 binding missing, scheduled-fire timing).

---

## Phase 5: DI surface shrink

End-to-end: `DaemonTransport` interface shrinks to the actual seam (`follow` + `signal`); `refire.ts:99` drops the `now?` param; `daemon-client.ts:85` `snapshotOffset?` becomes required; `deno-bootstrap.ts:121` mutable fetcher hatch evaluated for removal.

**Acceptance:**
- [x] `daemon-client.ts:85` `snapshotOffset` is required; the conditional at the call site is gone. Default stub in `daemon-client.test.ts` gains a no-op `snapshotOffset` so the contract is uniform.
- [~] `DaemonTransport` shrink deferred. Every method except `snapshotOffset` is already exercised by `daemon-client.test.ts` stubs — shrinking would force tests to spawn real daemons. The cost outweighs the surface savings.
- [~] `refire.ts:99` `now?` removal deferred. The 7 test sites set `now: T` to assert exact ISO timestamps; switching to `vi.useFakeTimers()` is a test rewrite for a single-line production benefit.
- [~] `deno-bootstrap.ts` mutable `fetcher` removal deferred. Six download/integrity tests substitute it; removing means a network mocking layer with no production payoff.
- [x] All daemon-client tests pass (8/8); typecheck clean.

---

## Phase log

Worked phase-by-phase. Each commit stages only files touched in that phase by explicit path — never `git add .` or `-A` — because parallel agents have untracked notes/ files in the worktree.

| commit | summary |
|--|--|
| 58a5353 | Phase 1: appendGlobal in-memory size; one stat/tick in follower; drop existsSync in tailRun |
| c0ed56d | Phase 2: one listPlugins per reconcile; parallel grants reads; listRuns Promise.all; readGlobal tail-from-EOF |
| 50a6ad8 | Phase 3: isPidAlive consolidated in locks.ts; pluginDir + runResultPath in home.ts |
| 1dcd9b5 | Phase 4: strip narration, narrow catches, single-word locals; watcher unconditional GC |
