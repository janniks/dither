# Plan: Off-thread qmd reconcile (index + embed in a child)

> Source: in-conversation design (2026-06-04). Spec TBD.

## Intent

**Problem.** The daemon runs `qmdReconcile` (index + embed) inline on its
main thread — `daemon.ts` `fireQmdReconcile` (`daemon.ts:343-365`) awaits
`qmdReconcile` (`daemon-jobs.ts:207`). Embedding can take minutes (model
download ~333MB, then per-chunk embed). While it runs, the daemon's
event loop is busy in native qmd code (`better-sqlite3`,
`node-llama-cpp`, `sqlite-vec`), so user-impacting work — firing,
scheduling, refiring, watch-debounce — stalls behind it.

**Approach.**

- Move the **whole** `qmdReconcile` (index + embed) into a **child
  process** that mirrors the existing daemon self-spawn pattern
  (`daemon-control.ts:166-181`). New hidden subcommand `daemon reconcile`,
  sibling to the hidden `daemon run` (`command-daemon.ts:185-198`).
- Child opens its own `openStore`, runs `store.update` then `embedLoop`,
  streams NDJSON progress on stderr (reuse the `_dither` convention from
  `supervisor.ts:52-77`). Daemon parses it and stays the **sole** writer
  of `jobs/` + `appendGlobal` (single-writer invariant, same as plugin
  runs journal via the daemon).
- The reconcile child runs **fully concurrent** with plugin-run children.
  No "pause embed during a user run" courtesy — there's no DB-writer
  conflict (plugins write `.md`; only the reconcile child writes the qmd
  sqlite index).
- The child **holds the qmd lock** (its own PID in the lock body), not the
  daemon — see Phase 4 rationale.

**Why child, not worker_threads.** qmd is native-addon-heavy: the sqlite
handle is thread-local, the llama model has global C++ state, nothing is
shareable across threads. A child gets clean isolation and keeps qmd
natives entirely out of the daemon's address space — the daemon main
thread never loads them.

## Architectural decisions

- **No new IPC shape.** The reconcile child is just another supervised
  child over stderr NDJSON — same shape as `supervise` (`supervisor.ts:79`).
- **Daemon owns the journal.** Child emits intent; daemon translates to
  `appendGlobal` + `jobs/<id>.json`. The child writes no run-log, no
  `jobs/`. Keeps `readJobsSnapshot` (`daemon-jobs.ts:119`) unchanged.
- **Lock honesty: holder PID == worker PID.** Move `acquireTheme` into the
  child so liveness tracks the real worker; a daemon crash can't strand a
  lock that a second embedder then reclaims while the orphan still writes.
- **`coalesce` stays.** `fireQmdReconcile` inflight/queued (`daemon.ts:336-365`)
  is kept verbatim — it now guards spawn-and-supervise instead of an
  inline await. Still prevents double-spawn.
- **Commit hygiene.** Each phase stages only files it touches by explicit
  path. Never `git add -A` / `.` — untracked `notes/plugin-*.md` live in
  the worktree.

---

## Phase 1: Child-runnable entrypoint + hidden `daemon reconcile`

End-to-end: the qmd reconcile body becomes a function invocable as its own
process, provable standalone before any daemon wiring.

- Add `runReconcileChild()` — moves the `qmdReconcile` body
  (`daemon-jobs.ts:207-258`): `openStore` → optional index → optional
  embed. Keep `claimReindex` / first-pass / `embedDisabled` gating logic
  identical.
- `withTruncationFilter` patches in-process `console.warn`
  (`progress.ts:159-178`) — it MUST run where embed runs, so it moves into
  the child path. Child computes the truncation count, folds it into its
  summary.
- Register hidden `reconcile` subcommand in `command-daemon.ts` mirroring
  the hidden `run` (`command-daemon.ts:185-198`, `hidden: true`, no
  `assertInitialized`). It calls `runReconcileChild()` then exits.
- This phase: child still writes `appendGlobal` + `jobs/` directly (so it
  works standalone). Phase 3 strips that out and routes through the daemon.

**Acceptance:**
- [x] `dither daemon reconcile` invoked by hand opens the store, indexes,
      exits 0 (or exits 0 on no-library / no-work). Embed half gated off in
      test to avoid the ~333MB model download (no existing test embeds for
      real either); clean-exit + index paths proven.
- [ ] `withTruncationFilter` no longer referenced from the daemon main
      thread; lives only on the child path. → **deferred to P3/P5**: private
      helper inside `embedLoop`, never referenced from the daemon module, but
      `embedLoop` still runs inline until P3 spawns the child.
- [x] Subcommand hidden in help; `assertInitialized` omitted (matches `run`).
- [x] Standalone test: invoke `runReconcileChild()` against a tmp library
      with real qmd, assert index counts (real impl, no mocks). Embed counts
      deferred (download).

---

## Phase 2: Child emits NDJSON progress on stderr

End-to-end: define the child→daemon message shapes; child stops writing
journal/jobs and instead streams its intent.

- Reuse the `_dither` envelope (`supervisor.ts:52`). Message kinds the
  child emits (one JSON object per stderr line):
  - `{_dither:"job-started", type, reason?}` — type ∈
    `model-download|indexing|embedding`.
  - `{_dither:"job-progress", type, current, total}` — debounced in the
    child (100ms, mirror `runJobWithLock` `PROGRESS_DEBOUNCE_MS`,
    `daemon-jobs.ts:387-402`).
  - `{_dither:"job-done", type, ...summary}` — embedding summary carries
    `chunks, truncated, iterations, durationMs`; indexing carries
    `filesIndexed, filesTotal`; model-download carries `durationMs`.
  - `{_dither:"job-skipped", type, reason}` — lock-busy (Phase 4).
  - `{_dither:"reconcile-done", jobsRun, reason?}` on clean finish.
- Child still owns the optimistic model-download bracket logic
  (`daemon-jobs.ts:316-357`): emit `model-download` job-started, close it
  on first embed progress or at end.
- Jobs need IDs: have the **daemon** mint the `jobId` (it's the journal
  writer). Child references jobs by `type` (only one job per type runs in
  a single reconcile); daemon maps type→jobId for the lifetime of the
  cycle. This keeps jobId allocation with the journal owner.
- Non-`_dither` stderr lines from the child = real diagnostics → daemon
  journals as `{kind:"stderr"}` (same as `supervisor.ts:117`).

**Acceptance:**
- [x] Message shapes documented in-file — `reconcile-protocol.ts` header +
      `parseReconcile` (Phase-3-reusable parser).
- [x] Child emits started/progress/done for a real **index** run; asserted by
      capturing the child's stderr in `reconcile-protocol.test.ts`. (Embed leg
      deferred — model download.)
- [~] Model-download bracket emitted even when nothing to embed — logic
      preserved verbatim through the sink; automated test deferred to P5
      (needs the download).
- [x] No `appendGlobal` / `jobs/` writes from the child — grep-clean
      (`appendGlobal`/`markJob*` only inside `journalSink`) + runtime-asserted
      (`readGlobal()` empty, no `jobs/`).

Note: two sink methods beyond the wire protocol — `jobFailed` /
`reconcileFailed` — exist for journal-path fidelity (old `job-failed` /
`reconcile-failed` events) and are no-ops on the stderr sink (the child
signals failure by throwing + non-zero exit; daemon reads exit code in P3).

---

## Phase 3: Daemon spawns + supervises the reconcile child

End-to-end: `fireQmdReconcile` spawns `daemon reconcile`, parses its
stderr, and is the sole writer of `jobs/` + `appendGlobal`.

- New `superviseReconcile()` (or extend `supervisor.ts`): spawn
  `process.execPath [argv1, "daemon", "reconcile"]` (mirror
  `daemon-control.ts:170-174`), `stdio:["ignore","ignore","pipe"]`,
  `env:{...process.env, DITHER_DAEMON:"1"}`.
- Line-buffer stderr (reuse `supervisor.ts:123-134` buffering). For each
  `_dither` message, the daemon does what `daemon-jobs.ts` did inline:
  - `job-started` → mint jobId, `markJobStarted`, `appendGlobal job-started`.
  - `job-progress` → `markJobProgress` + `appendGlobal job-progress`.
  - `job-done` → `markJobEnded` + `appendGlobal job-done`.
  - `job-skipped` → `appendGlobal job-skipped`.
  - `reconcile-done` → emit `reconcile-done` after child close.
- `fireQmdReconcile` (`daemon.ts:343-365`): the `inflight`/`queued`
  coalescing stays; `inflight` now resolves when the child process closes,
  not when an inline promise settles. Keep `REFIRE_MIN_MS` debounce and
  the `needsReindexPath` re-fire check (`daemon.ts:359-363`).
- `reconcile-started` is emitted by the **daemon** at spawn time (it owns
  the cycleId), before/around the spawn — preserves the
  started/done bookend that watchers depend on (`daemon-jobs.ts:210`,
  init watch, `dither status`).
- Track the child PID on the daemon (a `reconcileChild` ref) for Phase 4
  shutdown.

**Acceptance:**
- [x] Daemon main thread no longer *executes* qmd (functional guarantee met
      — `superviseReconcile` spawns the child; daemon only touches the
      journal surface + `parseReconcile`). Import-graph via daemon-jobs now
      clean too: the `daemon.ts → daemon-jobs.ts → store.ts → @tobilu/qmd`
      edge is severed by the P5 module split — `daemon-jobs.ts`'s transitive
      graph is `{home, locks, markers, run-log}`, no qmd. (Finalized in P5.)
- [x] `dither status` shows index + embed jobs identically to before — same
      `jobs/` files + log events, now produced via supervisor→`journalSink`.
      Proven by `reconcile-supervisor.test.ts`: NDJSON→journal output is
      event-for-event equal to the inline `journalSink` path (jobId/ts aside).
- [ ] Concurrent: plugin fire during an in-progress reconcile runs without
      waiting. → deferred: the daemon never blocked on the child even before
      (inline was already non-awaited in the main loop); concurrency holds by
      construction (separate process). No dedicated mid-embed test (needs the
      model download). Carry to P5 alongside the embed end-to-end.
- [x] `fireQmdReconcile` coalescing preserved verbatim — `inflight`/`queued`
      now resolves on child close (`sup.done`); `REFIRE_MIN_MS` + the
      `needsReindexPath` re-fire check unchanged.
- [x] daemon-jobs / daemon tests pass (env/deno failures are pre-existing,
      unrelated; zero new failures). reconcile-supervisor unit test added.

---

## Phase 4: Lock ownership → child; shutdown drain; SIGHUP

End-to-end: the qmd lock moves to the child, and the daemon drains/kills
the reconcile child on shutdown.

- **Lock ownership decision (RECOMMENDED: child holds the lock).**
  Today `acquireTheme` writes the daemon's PID. If the daemon crashes
  mid-embed, a respawned daemon could reclaim the (now stale-by-PID) lock
  and spawn a SECOND embedder while the orphaned child still writes the
  sqlite index → double-writer. Moving `acquireTheme("index"|"embed")`
  into the child makes the lock honest: holder PID == the process doing
  the work, so reclaim only happens when the worker truly dies.
  - Child acquires the theme lock at the start of each phase
    (`locks.ts:169`), releases at end. If `acquireTheme` returns null
    (busy → another reconcile child is live), child emits `job-skipped`
    and proceeds to the next phase / exits clean. Small startup race is
    benign: at most one child wins each theme.
  - `statusAll()` cross-check in `reduceJobsSnapshot` (`daemon-jobs.ts:179-184`)
    still works — it just reads whatever live PID holds the lock.
- **Shutdown.** `shutdown()` (`daemon.ts:379-395`) currently drains only
  plugin children via `readRunningPlugins`. Add: if a reconcile child is
  live, `SIGTERM` it and wait (bounded by the same `SHUTDOWN_GRACE_MS`,
  `daemon.ts:28`). Child releases its lock on SIGTERM (release in a
  `finally`), so no stale lock survives a clean stop.
- **SIGHUP.** `onHup` (`daemon.ts:397-407`) still calls `fireQmdReconcile`
  — now spawns the child. Unchanged call site.

**Lock ownership — already child-held as of P3.** `acquireTheme` is called
only inside `runIndexJob`/`runEmbedJob` (`daemon-jobs.ts`), which run inside
`qmdReconcile` → `runReconcileChild`, invoked solely by the `daemon
reconcile` subcommand — a separate child process. `daemon.ts` imports only
`clearInflightJobs` and never touches `acquireTheme`. So "move lock to child"
was structurally done in P3; P4 just locks the invariant in with a test and
adds the shutdown drain + child SIGTERM handling (the real new work).

**Acceptance:**
- [x] Theme lock body holds the **child's** PID during reconcile — asserted via
      the **index** leg (`reconcile-child.test.ts`: read `themeLockPath("index")`
      on the first indexing `job-progress`; body === the reconcile process pid).
      Embed leg skipped (model download); index acquires a theme lock the same way.
- [~] Daemon crash mid-embed → orphan holds lock; fresh daemon does NOT spawn a
      second embedder. Structurally guaranteed: the lock body holds the child's
      PID, so `acquireTheme` only reclaims when `isPidAlive` says the worker is
      truly dead → a live orphan blocks the new child → `job-skipped`. No
      dedicated crash-sim test (needs a real mid-embed / model download); carried
      with the embed end-to-end to P5.
- [x] `dither daemon stop` mid-reconcile: child receives SIGTERM, releases lock,
      daemon exits within grace; no stale `qmd-embed.lock`. **Graceful path**:
      child SIGTERM handler sets a stop flag the index/embed loop checks between
      iterations (same seam as the embed-disabled marker); the in-flight native
      batch finishes, then `runJobWithLock`'s finally releases the theme lock.
      Shutdown drains the child inside the SAME `SHUTDOWN_GRACE_MS` budget (signal
      up front, one shared wait loop). Tested via injectable spawn
      (`daemon.test.ts`): shutdown SIGTERMs the live child and exits well within
      grace. Caveat: `store.embed()` is a BLOCKING node-llama-cpp call — a JS
      handler can't interrupt mid-batch; worst case (hard kill) the PID-stamped
      lock is reclaimable via `isPidAlive`.
- [x] SIGHUP during idle still triggers a reconcile child — `onHup` →
      `fireQmdReconcile` → `superviseReconcile` (spawn) unchanged; verified.

---

## Phase 5: Cancellation + model-download; split qmd runners out of daemon-jobs

End-to-end: `dither index cancel` cancels the in-child embed; the qmd job
runners move OUT of `daemon-jobs.ts` into a child-only module so the daemon
main thread's static import graph is finally qmd-free.

> **Reframing.** The runners (`runIndexJob`/`runEmbedJob`/`runJobWithLock`/
> `qmdReconcile`/`runReconcileChild`) are NOT dead — P3 moved them from
> "called inline by the daemon" to "called only by the reconcile child".
> Nothing is deletable. The acceptance that matters is "daemon-jobs.ts no
> longer references openStore / embedLoop / acquireTheme; only the journal
> surface remains." So Phase 5 is a **module SPLIT**, not a delete.

- **Cancellation.** `dither index cancel` writes the `embed-disabled`
  marker (`markers.ts:120-124`). `embedLoop`'s `shouldCancel` checks
  `readMarkerState().embedDisabled` between iterations
  (`progress.ts:128-129`, wired at `daemon-jobs.ts:354`). Since the marker
  is a file, the child reads it directly — confirm the child's embed loop
  still exits cleanly between iterations (current batch finishes, no new
  iterations queued).
- **Model download.** First-run ~333MB fetch happens inside the child's
  first `store.embed`. The optimistic `model-download` job-started/done
  bracket now rides the child→daemon stream (Phase 2). Verify the daemon
  renders the download phase distinctly in `dither status`.
- **Module split (behavior-preserving MOVE).** Create `reconcile-run.ts`
  (child-only) and move `runReconcileChild`, `qmdReconcile`, `runIndexJob`,
  `runEmbedJob`, `runJobWithLock` into it — byte-equivalent except adjusted
  imports/exports. `daemon-jobs.ts` keeps ONLY the journal surface
  (`markJob*`, `readJobsSnapshot`, `reduceJobsSnapshot`, `clearInflightJobs`,
  jobs-dir helpers, the `Job`/`Snapshot`/`ReconcileSummary` types) and no
  longer imports `openStore`/`embedLoop`/`acquireTheme`/`store`/`progress`.
  The hidden `reconcile` subcommand dynamic-imports the new module.

**Acceptance:**
- [x] `dither index cancel` mid-embed stops the child's loop between
      iterations; lock released; `dither status` shows no live embed.
      → Marker-gated skip proven (`reconcile-child.test.ts`: with
      `embed-disabled` set the child indexes, emits NO embedding/model-download
      job, leaves no `qmd-embed.lock`, exits clean). Same `embedLoop`
      `shouldCancel` seam (OR'd with the P4 SIGTERM stop flag) preserved by the
      move. Mid-batch interrupt unchanged: native `store.embed()` blocks, so
      cancellation is between iterations (honest caveat from P4). Real
      mid-embed download path = manual-verify (333MB).
- [~] First-run download events appear in the log via the child stream.
      → Logic preserved verbatim in the relocated `runEmbedJob` (optimistic
      `model-download` job-started/done bracket rides the child→daemon NDJSON
      stream, P2/P3). A real end-to-end download test is out of scope
      (network + 333MB) → **manual-verify**.
- [x] `daemon-jobs.ts` no longer references `openStore` / `embedLoop` /
      `acquireTheme`; only the journal-writing surface remains.
      → grep-clean; its whole transitive graph is now `{home, locks, markers,
      run-log}` (qmd-free), asserted by an import-graph guard test in
      `daemon-jobs.test.ts`. Resolves the P3 [~] import-graph box: the
      `daemon.ts → daemon-jobs.ts → store.ts → @tobilu/qmd` edge is gone.
      (`daemon.ts` still reaches `store.ts` via the unrelated, pre-existing
      promotion path `plugin-run → promotion → update-index → store`, which is
      out of scope for this plan.)
- [x] Full daemon + daemon-jobs + daemon-client test suites pass.
      → 38 pass / 1 pre-existing deno-PATH failure (identical on clean HEAD),
      zero new failures. Test imports for moved funcs updated
      (`reconcile-child.test.ts`, `reconcile-protocol.test.ts`,
      `daemon-jobs.test.ts`).

---

## Phase 6 (follow-on, lighter): kick/lock/journal state must not lie

End-to-end: the "is it running?" model stops contradicting itself once an
embed child PID is in play. Full design deferred — this phase scopes the
inconsistency, not a rewrite.

- Today `plugin run` pre-check treats kick-existence OR held-lock as
  "already running" (`command-plugin-run.ts:230`), but `tailRun`
  (`command-plugin-run.ts:114`) waits silently and `plugin runs` can still
  say "no runs yet" — the three surfaces can disagree.
- Account for the reconcile child: it holds a `qmd-*` lock, not a
  per-plugin lock, so it must NOT make a plugin look "running". Verify
  `readRunningPlugins` (`daemon.ts:170-193`) and `isLockHeld`
  (`locks.ts:132`) only ever see `<plugin>.lock`, never `qmd-*.lock`
  (they filter `.lock` suffix but not the `qmd-` prefix — confirm/guard).
- CLI should own and clear its own kick on Ctrl-C so a interrupted `run`
  doesn't leave a stale kick that reads as "already running"
  (`clearKick`, `kicks.ts:63`).

**Acceptance:**
- [x] A live reconcile child never makes any plugin report as running in
      `dither status` or block `dither plugin run`. (`isPluginLock` in
      `locks.ts` filters `qmd-*`/`daemon-start`; `readRunningPlugins`
      skips them — `daemon.test.ts` "skips reserved qmd-*/daemon-start
      locks". `isLockHeld` left as-is: it's name-specific, only ever
      passed a real plugin name.)
- [x] `plugin run` + `plugin runs` + status agree on running-ness in the
      kick→fire→done window — an interrupted run no longer leaves a stale
      kick that reads as "already running" while `runs` shows nothing.
- [x] Ctrl-C during a foreground `plugin run` clears the kick it wrote
      (`onInterrupt` wires `clearKickOnInterrupt(plugin)` around the
      foreground `tailRun`; `--detach` returns first, so it's unaffected).
- [ ] (Deferred, by design: a fuller kick/lock/journal unification AND the
      silent-tail UX — `tailRun` showing "waiting for daemon, currently
      embedding…" — remain a later pass. Not done here; scope was just the
      two state-lie fixes.)

---

## Open questions

- **jobId ownership** (Phase 2): daemon-mints vs child-mints. Plan assumes
  daemon mints (it's the journal writer, one job per type per cycle). If a
  cycle ever needs >1 job of the same type, revisit.
- **`reconcile-failed` semantics** (Phase 3/4): on child non-zero exit, the
  daemon logs `reconcile-failed` and lets the next trigger re-run. Confirm
  no partial `jobs/` file is left for the failed type (daemon `markJobEnded`
  on child close regardless of exit code).
- **Phase 6 depth**: scope here is just "don't lie about reconcile child as
  a plugin". The broader kick/lock/journal unification may warrant its own
  spec.

---

## Phase log

| commit | summary |
|--|--|
| P1 | `runReconcileChild()` + hidden `daemon reconcile` subcommand; standalone real-qmd index test (15 pass, typecheck clean) |
| P2 | sink seam (`reconcile-sink.ts` journal/stderr) + NDJSON protocol (`reconcile-protocol.ts` + `parseReconcile`); child streams stderr, daemon-inline journal unchanged (17 pass, daemon-jobs.test unmodified) |
| P3 | `reconcile-supervisor.ts` (`superviseReconcile` + testable `reconcileHandler`); daemon spawns `daemon reconcile`, parses NDJSON, sole journal writer; `fireQmdReconcile` rewired (coalescing kept); `reconcile` subcommand dynamic-imports `runReconcileChild`. Functional qmd-off-thread met; import-graph clean deferred to P5. Child PID tracked on `reconcileChild` for P4. Typecheck clean; reconcile-supervisor unit test (3 pass), zero new failures |
| P4 | Lock confirmed child-held (no move needed — done structurally in P3); lock-body-holds-child-PID test via index leg (`reconcile-child.test.ts`). Child SIGTERM/SIGINT → stop flag threaded through `qmdReconcile`/`runEmbedJob`/`embedLoop` (OR'd with embed-disabled marker), `runJobWithLock` finally releases lock. Shutdown drain: signal reconcile child up front, fold into the single `SHUTDOWN_GRACE_MS` wait loop (no second grace). `runDaemon(spawn)` seam for the drain test (`daemon.test.ts`). SIGHUP path unchanged. Honest caveat: native `store.embed()` blocks — graceful only between iterations. Typecheck clean; reconcile+daemon+locks: 50 pass, 1 pre-existing deno failure, zero new |
| P6 | State must not lie: (1) `isPluginLock(name)` helper in `locks.ts` (single source for reserved `qmd-*`/`daemon-start` lock names) — `readRunningPlugins` (`daemon.ts`) now skips them so a live reconcile child can't masquerade as a plugin in `dither status`/block `plugin run`; shutdown drain correct (reconcile child drained explicitly in P4). (2) `clearKickOnInterrupt(plugin)` + `onInterrupt` wiring in `command-plugin-run.ts` — foreground Ctrl-C clears the CLI-written kick (ENOENT-tolerant; doesn't kill a running daemon-side run); `--detach` unaffected. `isLockHeld` left as-is. Tests (real impl): locks `isPluginLock`, daemon `readRunningPlugins` filter, kick clear/no-op/`--detach`-leaves. Typecheck clean; 75 pass, 1 pre-existing deno-PATH failure (`fires runPlugin within ~3s`, identical on clean tree), zero new. Broader kick/lock/journal unification + silent-tail UX deferred. |
| P5 | Reframed: split, not delete. Moved `runReconcileChild`/`qmdReconcile`/`runIndexJob`/`runEmbedJob`/`runJobWithLock` into new child-only `reconcile-run.ts` (byte-equivalent, imports adjusted). `daemon-jobs.ts` now journal-surface-only — grep-clean of `openStore`/`embedLoop`/`acquireTheme`; transitive graph `{home,locks,markers,run-log}`, qmd-free (closes the P3 [~] import-graph box). `reconcile` subcommand dynamic-imports `../reconcile-run`. Import-graph guard test + embed-disabled cancellation test added. Test imports updated (`reconcile-child`/`reconcile-protocol`/`daemon-jobs`). model-download bracket preserved (manual-verify). Typecheck clean; 38 pass, 1 pre-existing deno failure (identical on clean HEAD), zero new |
|  |  |
