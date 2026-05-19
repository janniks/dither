# Plan: init polish + background embed

> Source spec: `specs/init-polish-and-background.md`

## Architectural decisions

- **Daemon**: long-lived, detached, singleton per machine; controlled via PID file + SIGHUP/SIGTERM. Auto-started by `dither init` with disclosure.
- **IPC**: append-only JSONL events log at `~/.dither/events.jsonl` (streaming progress + lifecycle); existing snapshot file at `~/.dither/daemon.status.json` (current-state queries). Watcher follows the log via `fs.open` + periodic `fs.fstat` + delta `fs.read` — no `fs.watch`, no platform quirks. Daemon rotates the log: truncate on start; rename to `events.jsonl.old` when current >1 MB.
- **Locks**: three per-theme lock files at `~/.dither/locks/qmd-{download,index,embed}.lock`. Atomic O_EXCL, stale-PID reclaim from existing `locks.ts`. Non-blocking acquire only — never wait. The lock *name* encodes the theme; busy message reads `existsSync` + `fstat(mtime)`.
- **Markers**: `~/.dither/needs-reindex` (deferred reindex coalescing — anyone touches it, daemon drains); `~/.dither/embed-disabled` (user cancelled embed; reconciler skips embed while present).
- **Reconciler model**: daemon is stateless w.r.t. work intent. On startup, SIGHUP, and post-job, it queries qmd's SQLite + marker files and queues whatever needs doing. Same code path handles fresh init, crash recovery, and on-demand triggers.
- **Welcome doc**: `<library>/welcome/welcome.md`. Library subdirs are qmd collections per `store.ts:25-31`, so the doc is searchable immediately. Skip-if-exists idempotency.
- **Flag convention**: `--no-X` family on `dither init` — `--no-download` (existing), `--no-welcome` (new), `--no-wait` (new). No omnibus flag.
- **Job kinds**: `model-download` → `indexing` → `embedding` (sequential, each takes its theme lock).
- **Embed loop-until-empty**: every embed phase calls `store.embed()` repeatedly until a call returns `chunksEmbedded === 0`. Dodges qmd's hardcoded 10-min `LLMSession` ceiling (`@tobilu/qmd/dist/llm.js:1049`) without requiring an SDK patch.
- **Init flow**: prompt library (existing) → write config + welcome doc → ensure daemon up → if `--no-wait`: dispatch + epilogue; else: follow events log, SIGINT/SIGHUP detaches cleanly with epilogue.
- **Status surface**: `dither status` shows everything (daemon overview, current job with live progress, recent jobs, `needs-reindex` marker state). The `dither index` namespace is *commands only*: `dither index update`, `dither index cancel`. No `dither index status`.
- **Relationship to `init-interactive.md`** (shipped): the prior spec established `DITHER_DIR` lookup, the interactive library prompt, the `prompt.ts` module, the non-TTY error path, and the two-row `dither status` output. None of those decisions are reopened. This plan extends `dither status`, replaces the `next:` epilogue, and adjusts `prompt.ts:confirm()`.

---

## Phase 1: Init voice cleanup

**User stories**: 1, 2, 4, 5

End-to-end behavior this slice delivers: `dither init` output reads as a single coherent voice, and embedding actually completes every chunk instead of silently dropping at the 10-minute session ceiling. No daemon work yet — these are pure UI + correctness fixes inside the existing inline init flow.

**Acceptance:**
- [ ] `confirm()` clears 2 lines on TTY so consola's `✔ Where should your library live?` echo is wiped, leaving only `✓ library: <path>` (already partly shipped — verify in a fresh `dither init` run that the echo is gone, fix if not).
- [ ] `confirm("Library", …)` callsite changed to `confirm("library", …)`. JSDoc note on `confirm()` codifies the lowercase-label convention.
- [ ] qmd's per-chunk `⚠ Batch text truncated to fit embedding context (2048 tokens)` warnings are filtered during embed; count is folded into the final summary as `(N truncated to fit 2048-token context)`. Other warnings pass through.
- [ ] Embed runs `store.embed()` in a loop until a call returns `chunksEmbedded === 0`. Final summary aggregates `chunksEmbedded` across calls. Each loop iteration gets a fresh `LLMSession` and so dodges the 10-min timeout. Smoke-test by checking `getStatus().needsEmbedding === 0` after init completes on a >2000-chunk library.
- [ ] All 276 existing tests still pass; new test covers the loop-until-empty behavior with a mock `embed` that returns 800 then 200 then 0 chunks across three calls.

---

## Phase 2: Model-download summary

**User stories**: 3

End-to-end behavior: `dither init`'s model-download phase no longer leaves `Downloading to … / progress bar / ✔ … downloaded NMB in T / Downloaded to …` in scrollback. While the download runs the qmd-emitted output is displayed live (undecorated, since prefixing breaks ipull/stdout-update's redraw). When the download completes, the entire captured block is erased and replaced with a two-line synthetic summary.

**Acceptance:**
- [ ] During the model download, a wrapper captures every byte qmd writes to stdout and tracks newline count so we know how many lines to erase.
- [ ] On download completion, the captured block is erased via `\x1b[<N>A\x1b[J` (cursor up N + clear to end of screen) on TTY; on non-TTY, no erasure (just print summary below).
- [ ] Replacement line 1: `✓ downloaded model weights (XXX MB in TT)` parsed via regex against qmd's `✔ … downloaded XXX MB in TT` line (handle `MB` and `GB` and `s`/`m`/`m s` forms).
- [ ] Replacement line 2: dim, two-space indent, tildified path of the gguf file, parsed from `Downloaded to <path>` line.
- [ ] If either parse fails (qmd reworded), fall back to generic `✓ downloaded model weights` with no path line. No crash.
- [ ] Unit test feeds canned qmd output strings (including the `\r`-redrawn bar segments) to the wrapper and asserts erase sequence + summary text. Negative case: malformed input → fallback line.

---

## Phase 3: Welcome doc + new epilogue

**User stories**: 15, 16

End-to-end behavior: after a successful `dither init`, the library contains a `welcome/welcome.md` doc that teaches the user the search → get pattern. The init epilogue's `next:` block points at it.

**Acceptance:**
- [ ] `<library>/welcome/welcome.md` is written when init succeeds, unless `--no-welcome` was passed. Skip if file already exists (don't clobber edited content on re-init).
- [ ] Content is short: explains dither in one paragraph, lists the next 2 commands (`dither search 'welcome to dither'`, `dither get <id>`), explains how to remove the welcome collection (`rm -rf <library>/welcome/` + `dither index update`).
- [ ] Init epilogue's `next:` line is now `next:\n  dither search 'welcome to dither'\n  dither get <id from above>`.
- [ ] `--no-welcome` flag skips welcome doc creation. When skipped, epilogue falls back to the original `next: dither plugin install <path>` line.
- [ ] Init.test extended: `--no-welcome` skips doc; default creates doc; re-init with existing doc doesn't overwrite.
- [ ] Smoke-test: `dither init` on a fresh library, then `dither search 'welcome to dither'` returns the welcome doc, then `dither get <id>` prints the content.

---

## Phase 4: Events log + per-theme locks (foundation)

**User stories**: 22, 23

End-to-end behavior: the daemon writes lifecycle events (`daemon-started`, `daemon-stopped`) to a new append-only JSONL log; `dither status` surfaces them. Three per-theme lock files exist with a thin wrapper, exercised by tests (no real callers yet). No behavior change to the user's init flow — this is purely substrate that the next phases will build on.

**Acceptance:**
- [ ] New module: events-log API exposes `appendEvent(event)`, `followEvents(filter?, signal): AsyncIterator`, and `truncate()`. Pure Node: `fs.open` for append fd, `fs.fstat` polling for follow, line buffering across reads, JSONL parsing. No `fs.watch`. ~100 lines.
- [ ] Rotation: log file is truncated to 0 bytes on daemon startup; appends past 1 MB trigger `rename(events.jsonl → events.jsonl.old)` + start fresh. Two files maximum, ever.
- [ ] New module: qmd-locks wrapper exposes `tryAcquire(theme: "download"|"index"|"embed"): LockHandle | { busy, startedAt }` and `status(): { download?, index?, embed? }`. Reuses existing `locks.ts` primitives.
- [ ] Daemon emits `{kind: "daemon-started", pid}` on start and `{kind: "daemon-stopped"}` on graceful shutdown.
- [ ] `dither status` reads the events log (last ~50 entries) and surfaces daemon-started timestamp.
- [ ] Tests: events-log append/read roundtrip, concurrent appends, rotation when crossing 1 MB, follow with abort signal terminates cleanly. qmd-locks acquire/release/status per theme, busy detection returns `{busy, startedAt}` matching mtime.

---

## Phase 5: Daemon owns embedding (reconciler v1)

**User stories**: 6 (partial), 7 (partial), 10 (full for embed)

End-to-end behavior: when `dither init` runs on a library with content, it runs download + index inline (as before), then sends SIGHUP to the daemon. The daemon's reconciler (v1: handles only embed-on-SIGHUP) sees `needsEmbedding > 0` and starts an embed job. Init follows the events log for live progress with current/total + ETA. `dither status` in another terminal shows the same embed.

**Acceptance:**
- [ ] New module: daemon-jobs exposes a thin reconciler that on SIGHUP checks `getStatus().needsEmbedding > 0` and, if so, queues an embed job. Embed job runs the loop-until-empty pattern from phase 1.
- [ ] Embed job acquires `qmd-embed.lock` at start, releases on completion (including on error/cancel). Emits `{kind: "job-started", jobId, type: "embedding", total}` event, `{kind: "job-progress", jobId, current, total}` per qmd `onProgress` tick (debounced ~100ms), and `{kind: "job-done", jobId, chunks, truncated, durationMs}` at the end.
- [ ] Init's old inline-embed code path now: writes config + welcome, runs download + index inline as before, then `kill(daemonPid, "SIGHUP")` to trigger reconciler, then opens the events log and follows it until the matching `job-done` arrives.
- [ ] Watcher renders progress through the existing `progress.ts`. ETA from elapsed + current/total.
- [ ] `dither status` extended to show current job (read from events log + lock existence) with progress and ETA.
- [ ] `dither init` ensures daemon is running before SIGHUPing it: calls `startDaemon()` idempotently with disclosure (`→ starting dither daemon...` / `✓ daemon started (pid X)` or `✓ daemon already running (pid X)`).
- [ ] Tests: daemon-jobs reconciler picks up embed on SIGHUP when needsEmbedding>0; ignores it when 0. Init test extended: end-to-end embed runs via daemon and watcher renders progress (mocked daemon-side qmd).

---

## Phase 6: Daemon owns model-download + indexing (reconciler v2)

**User stories**: 6 (full), 7 (full), 17, 20

End-to-end behavior: `dither init` becomes pure dispatch-then-watch from the very first job. Download and indexing both run inside the daemon. Reconciler is extended to discover all three job kinds via state inspection. After a crash the daemon auto-resumes unfinished work on next start.

**Acceptance:**
- [ ] Daemon-jobs gains two job runners: model-download and indexing. Each takes its own theme lock; emits start/progress/done events.
- [ ] Reconciler v2 runs on three triggers: daemon startup, SIGHUP, post-job. On each trigger it checks in order: model file missing → queue download; `~/.dither/needs-reindex` marker present (or library has new files since last index) → queue indexing; `getStatus().needsEmbedding > 0` AND no `embed-disabled` marker → queue embedding. Jobs run sequentially (one lock at a time).
- [ ] Init's inline download + index code paths are removed. Init now: writes config + welcome, ensures daemon, SIGHUPs daemon, opens events log, follows until all queued jobs done.
- [ ] If daemon is restarted mid-embed (e.g., user runs `dither daemon stop && dither daemon start`), the reconciler on startup discovers the still-needs-embedding chunks and resumes. Verified via test that simulates daemon stop/start during embed.
- [ ] Plugin post-promote `updateIndex(touched)` call (`plugin-run.ts:512`) now attempts `qmd-locks.tryAcquire("index")`; on success, runs as before; on busy, `touch ~/.dither/needs-reindex` + skip silently. Plugin tests updated.
- [ ] Tests: reconciler decides correct sequence given synthetic state (model missing, marker present, needsEmbedding>0). End-to-end init test with mocked daemon-side qmd verifies download → index → embed sequence and events log entries.

---

## Phase 7: Ctrl-C detach, `--no-wait`, `dither index` commands

**User stories**: 8, 9, 11, 13, 14, 18

End-to-end behavior: a user watching a long embed can press Ctrl-C to disconnect; the daemon keeps embedding. Init prints a detach block plus the standard epilogue. `--no-wait` skips the watch entirely (CI use). `dither index cancel` actually stops the running job; `dither index update` resumes deferred work.

**Acceptance:**
- [ ] Init's SIGINT and SIGHUP handlers disconnect the watcher cleanly, write the detach block (`✓ detached. daemon continues. dither status / dither index cancel`), print the standard welcome / next-action epilogue, exit 0. Daemon never receives these signals (it's detached); confirm with a manual test (Ctrl-C during a real embed, then `dither status` shows the embed still running).
- [ ] New flag: `--no-wait` skips the events-log follow. After daemon dispatch, init prints `→ dispatched. daemon will finish in background. dither status to check.` plus the epilogue, exits 0.
- [ ] New command: `dither index cancel`. Reads the three lock files to find the active job. Sends SIGTERM to the holder PID. If the active job is an embed, writes `~/.dither/embed-disabled` marker (so the next reconciliation doesn't re-resume). Waits up to 5s for the lock to release. Prints `✓ cancelled <theme>`.
- [ ] New command: `dither index update`. Deletes `~/.dither/embed-disabled` marker (resumes embed eligibility). Touches `~/.dither/needs-reindex` marker. Sends SIGHUP to daemon. Exits 0. (The daemon's reconciler does the rest.)
- [ ] Daemon's reconciler honors `embed-disabled`: when present, skips embed even if `needsEmbedding > 0`. `dither index update` clears it.
- [ ] Tests: init test for SIGINT during watch triggers detach block + epilogue, exit 0, no kill signal to daemon. `--no-wait` test: dispatch then exit without waiting. dither-index-cancel test: writes embed-disabled marker, signals holder, waits for lock release. dither-index-update test: clears embed-disabled, touches needs-reindex, SIGHUPs daemon.

---

## Phase 8: Search footer, plugin deferral message, uniform busy messages

**User stories**: 12, 19, 21

End-to-end behavior: edges and rough corners are smoothed. Search during an active embed surfaces a one-line footer so users aren't confused by partial results. Plugin-run that defers a reindex tells the user so. Competing commands print a uniform busy message naming the theme.

**Acceptance:**
- [ ] `dither search` checks `existsSync(qmd-embed.lock)`; if true, prints a footer line: `note: embedding still in progress. some results may be missing — re-run when done.` Footer cost is one stat call. Doesn't fire when lock is absent.
- [ ] `dither get` does NOT print this footer (doesn't depend on embeddings).
- [ ] Plugin post-promote reindex that defers (from phase 6) prints `(reindex deferred — daemon busy)` to its run log. Plugin test asserts the marker file was touched.
- [ ] All write-side callers (`dither init` second instance, `dither index update`) on busy lock print the uniform message `qmd is busy: <theme> (started Xs ago). watch with 'dither status'.` and exit non-zero. `Xs` is computed from lock file mtime.
- [ ] Test: `dither search` test with `qmd-embed.lock` present asserts footer; without lock, no footer. Test: second `dither init` while first holds `qmd-index.lock` prints the busy message + exits non-zero.

---

## Phase log

When starting implementation, rename this file to `./plans/init-polish-and-background-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. Stage and commit only that phase's changes after finishing, then continue to the next phase on your own. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/init-polish-and-background.md`.

| Commit | Summary |
|--------|---------|
|        |         |
