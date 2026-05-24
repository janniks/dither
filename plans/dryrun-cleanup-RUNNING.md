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
- [ ] `appendGlobal` (`run-log.ts:127`) no longer calls `existsSync` / `statSync` per event; size is tracked in memory or `stat` is async with ENOENT catch.
- [ ] Follow loop (`run-log.ts:250-291`) stats the file at most once per tick; inode change is detected from the same stat.
- [ ] `tailRun` (`commands/plugin.ts:625-641`) no longer runs its own `existsSync(resultPath)` poll — relies on the follower's view of the dir.
- [ ] Existing `run-log.test.ts` + `plugin-runs.test.ts` pass unchanged.
- [ ] Commit message: `perf(run-log): drop sync stat in appendGlobal + dual-stat in follower`.

---

## Phase 2: Daemon heartbeat + SIGHUP reconcile

End-to-end: 1 Hz `writeStatusSnapshot` stops doing N+1 reads of every run dir; SIGHUP stops reading every grants file twice.

**Acceptance:**
- [ ] `writeStatusSnapshot` (`daemon.ts:189`) reads `recentRuns` from a cache populated by Run open/close, not by re-scanning `historyDir` every second.
- [ ] `daemon.ts:68-97` (`loadScheduleEntries` + `loadWatchEntries`) reads each grants file once per SIGHUP; reads fan out via `Promise.all`. `listPlugins` in `plugin-list.ts:33-44` parallelizes its grants reads.
- [ ] `daemon-jobs.ts:131-153` `readJobsSnapshot` no longer allocates a whole-file buffer to slice the last 200 rows; reads bounded chunk from EOF.
- [ ] `daemon.test.ts` + `daemon-jobs.test.ts` pass.
- [ ] Commit: `perf(daemon): cache recentRuns + parallelize grants reads`.

---

## Phase 3: Reuse — `isPidAlive` + `home.ts` path helpers

End-to-end: One `isPidAlive` exported from `locks.ts`; `daemon-control.ts` and `daemon-client.ts` import it. Plugin dir + run result path live in `home.ts`; three callers stop rebuilding joins.

**Acceptance:**
- [ ] `locks.ts` exports `isPidAlive(pid): boolean`. `daemon-control.ts:24` and `daemon-client.ts:88` deleted; both import the shared one.
- [ ] `home.ts` exports `pluginDir(name)` and `runResultPath(id)`. `plugin-run.ts:215`, `plugin-remove.ts:12`, `plugin-install.ts:142`, and `commands/plugin.ts:577` use them.
- [ ] All tests touching these modules pass.
- [ ] Commit: `refactor: one isPidAlive + pluginDir/runResultPath in home.ts`.

---

## Phase 4: Quality pass — comments, try/catch, control flow, naming

End-to-end: narrating comments stripped; broad try/catch narrowed or removed; `let`-then-assign patterns become early returns; the densest multi-word-locals clusters get short names; watcher suppress map sweeps unconditionally.

**Acceptance:**
- [ ] Narrating comments removed: `commands/init.ts:85`, `commands/plugin.ts:163`, `commands/index.ts:34`, `daemon-client.ts:153-156`, `daemon-client.ts:161-163` (keep only the latency rationale).
- [ ] Try/catch narrowed: `daemon.ts:82-94` and `:168-174` narrow to ENOENT/SyntaxError; `inbox.ts:41-47` switched to a parse-or-null helper or replaced with a guard; `status.ts:101-106` replaced with `access` returning a boolean.
- [ ] `commands/status.ts:54-67` rewritten as early-return helper; `:17-29` lookup or early-return.
- [ ] `daemon-client.ts:172-175` cluster renamed to single words where unambiguous (`started`, `aborted`, `ac`, `timer`, `opts`, `offset`); `daemon.ts:308-315` same (`inflight`, `queued`, `lastStart`); `progress.ts:122-126` (`embedded`, `duration`, `truncated`, `total`).
- [ ] `watcher.ts:147-152` sweep runs unconditionally on TTL; the `size > 64` gate removed.
- [ ] All tests pass.
- [ ] Commit: `refactor: strip narration, narrow catches, single-word locals`.

---

## Phase 5: DI surface shrink

End-to-end: `DaemonTransport` interface shrinks to the actual seam (`follow` + `signal`); `refire.ts:99` drops the `now?` param; `daemon-client.ts:85` `snapshotOffset?` becomes required; `deno-bootstrap.ts:121` mutable fetcher hatch evaluated for removal.

**Acceptance:**
- [ ] `DaemonTransport` has only the methods that vary in tests; the rest call real modules directly. `daemon-client.test.ts` updated to match.
- [ ] `refire.ts:99` `decideRunOutcome` drops `now?`; tests use `vi.useFakeTimers()` or accept the real clock.
- [ ] `daemon-client.ts:85` `snapshotOffset` is required; branch at `:229` deleted.
- [ ] `deno-bootstrap.ts:121` — if removable without losing test coverage, remove; otherwise document why it stays (single-line comment, WHY only).
- [ ] All tests pass.
- [ ] Commit: `refactor(daemon-client): shrink transport seam; drop test-only DI`.

---

## Phase log

Worked phase-by-phase. Each commit stages only files touched in that phase by explicit path — never `git add .` or `-A` — because parallel agents have untracked notes/ files in the worktree.

| commit | summary |
|--|--|
|  |  |
