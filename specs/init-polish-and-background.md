---
status: draft
priority: P1
supersedes-parts-of: init-interactive.md
---

# init polish + background embed

## Relationship to `init-interactive.md`

`specs/init-interactive.md` is shipped (`status: complete`). It established
the foundations this spec builds on: the `DITHER_DIR` lookup chain, the
interactive library prompt, the `prompt.ts` module wrapping consola, the
non-TTY error path, and the two-row `dither status` output for config dir
vs library. None of those decisions are reopened here.

This spec is *additive* on top of that work, with three concrete deltas:

- **Init epilogue (`next:` line) replaced.** `init-interactive.md` ended
  with `next: dither plugin install <path>`. This spec replaces that with
  the welcome-doc demonstration (`dither search 'welcome to dither' ;
  dither get <id>`). The original `next: dither plugin install <path>`
  survives as the fallback when `--no-welcome` is passed.
- **`prompt.ts:confirm()` adjusted.** Gets a 2-line clear (was 1) to wipe
  consola's submit-frame echo so only our `✓ library: …` line remains,
  and a JSDoc note that labels should be lowercase. The module itself
  (and `promptText`) is unchanged.
- **`dither status` extended.** In addition to the config-dir + library
  rows the prior spec added, status now also shows current job (with
  live progress), recent jobs (from the events log), and the
  `needs-reindex` marker state. The two-row split is preserved.

Anything the prior spec marked "out of scope" — `dither config`
reconfiguration surface, content migration tooling, `ink` adoption,
stricter XDG split — remains out of scope here.

## Problem Statement

`dither init` today is a single foreground process that downloads model weights, indexes the library, and embeds every chunk inline before returning. Several pain points fall out of that:

- The first init on a library with non-trivial content can take many minutes (one user reported nearly 10 minutes) with no way to back out without killing the work, no way to keep using the terminal, and no progress detail beyond a spinner.
- qmd's underlying `LLMSession` has an undocumented hardcoded 10-minute timeout (`@tobilu/qmd/dist/llm.js:1049`); when it expires, embedding silently drops the remaining chunks. The user ends up with a partially-embedded index and no warning.
- Output during init is noisy and inconsistent: qmd's own download bar (`Downloading to … / ✔ … downloaded NMB in T / Downloaded to …`) is followed by dozens of `⚠ Batch text truncated to fit embedding context (2048 tokens)` warnings and occasional `⚠ Session expired — skipping N remaining chunks` lines. Both `✔` (consola, qmd) and `✓` (dither) checkmark glyphs appear in the same session. The library-confirmation line uses Title Case (`Library:`) where the rest of the output is sentence-case (`indexed N files`, `embedded N chunks`).
- The `next:` epilogue points at `dither plugin install <path>` — a sensible eventual step but not the immediate "you can use search and get now" cue a first-time user wants.
- If a second `dither init` or any qmd-mutating command (plugin promote → reindex, `dither index update`) collides with an inline embed, they fight over qmd's SQLite. There's no coordination today.

## Solution

Three independently-shipped, individually-coherent improvements:

**(1) Display polish.** Clean up everything visible during init.

- Lowercase the library confirm label (`library: ~/.dither/library`) to match the rest of the inline output.
- Wipe consola's `✔ Where should your library live?` prompt echo so only one line — our `✓ library: …` — remains.
- Synthesize the model-download summary from qmd's own scrollback. Print a `→ downloading model weights…` lead, let qmd's bar run undecorated (any attempt to indent or prefix the bar would fight `stdout-update`'s line-counted redraw), and on completion erase the entire qmd-emitted block and replace with a two-line summary:
  ```
  ✓ downloaded model weights (333MB in 2m)
    ~/.cache/qmd/models/hf_…-Q8_0.gguf
  ```
  Size + duration are parsed via regex against qmd's deterministic `✔ … downloaded NMB in T` line, with a generic-text fallback if the parse misses.
- Suppress qmd's per-chunk `⚠ Batch text truncated to fit embedding context (2048 tokens)` warnings during embed; count them and fold the count into the final summary: `✓ embedded N chunks in T (M truncated to fit 2048-token context)`.
- Fix the `Session expired — skipping N chunks` silent partial-completion by looping `store.embed()` until `chunksEmbedded === 0` (each call gets a fresh 10-minute session). The same loop is what the daemon runs naturally — the fix and the new design converge.

**(2) Write a welcome doc and rewrite the next-action epilogue.**

`dither init` writes `<library>/welcome/welcome.md` (unless `--no-welcome` is passed). The `welcome/` subdir automatically becomes a qmd collection — library subdirs are collections per `store.ts:25-31`. The doc content is a short tutorial covering `dither search`, `dither get`, and how to remove the welcome collection later (`rm -rf <library>/welcome/` + `dither index update`). The init epilogue's `next:` block becomes:

```
next:
  dither search 'welcome to dither'
  dither get <id from above>
```

— teaching the search → get pattern by demoing it on a real doc.

**(3) Move the long-running work to the daemon; init becomes a watcher.**

The daemon — already a long-lived background process today, opt-in via `dither daemon start`, auto-started by `dither plugin install` — takes ownership of the three init phases: model download, indexing, embedding. `dither init` ensures the daemon is up (with disclosure: `→ starting dither daemon… / ✓ daemon started (pid X)`), then *watches* the daemon's progress by following an append-only JSONL event log at `~/.dither/events.jsonl`. The daemon is a **state reconciler**: on startup, after SIGHUP, and after each completed job, it discovers what needs doing by querying qmd state — missing model file → queue a download; `needs-reindex` marker file → queue indexing; `getStatus().needsEmbedding > 0` → queue embedding. Same logic handles fresh init, crash recovery, and explicit user requests.

While watching, the user can press **Ctrl-C** to detach cleanly. The daemon keeps running; init prints a detach block showing how to monitor and how to actually cancel, then prints the full init epilogue (welcome doc reference + next-action commands) and exits 0. SIGHUP (terminal close) behaves identically. The actual job is cancellable via the separate explicit command `dither index cancel`.

For libraries large enough that an embed pass exceeds ~500 chunks, init prints a `Ctrl-C to detach (daemon will finish in background)` tip so users discover the escape hatch when they need it.

Three per-theme lock files at `~/.dither/locks/qmd-{download,index,embed}.lock` (reusing existing `locks.ts` primitives — atomic O_EXCL, stale-PID reclaim) prevent two processes from writing to qmd state at the same time. The lock *name* encodes the theme; the busy message just needs `existsSync()` + `fstat` for elapsed: `qmd is busy: indexing (started 12s ago). watch with 'dither status'`. Acquires are non-blocking — either you get the lock or you don't; no waiting. Plugins that can't acquire `qmd-index.lock` for their post-promote reindex `touch ~/.dither/needs-reindex` and exit; the daemon coalesces deferred work into one follow-up reindex.

Non-TTY (CI, pipes) behaves the same as TTY by default — block until the daemon finishes. `--no-wait` opts into background dispatch-and-return for scripts that don't want to block. `dither search` during an embed pass shows a one-line footer warning that results may be partial (driven off `existsSync(qmd-embed.lock)`).

`dither status` shows everything (daemon overview + current job with live progress + recent jobs + `needs-reindex` marker state) — no separate `dither index status` command. The `dither index` namespace exists only for *commands that act* on the index: `dither index update`, `dither index cancel`.

## User Stories

1. As a dither user running `dither init`, I want only one library-choice confirmation line to remain after I answer the prompt, so my terminal scrollback isn't cluttered with both the question and my answer.
2. As a dither user, I want all dither-emitted output to use one consistent checkmark and sentence-case style, so the UI reads as a single voice.
3. As a dither user, I want the model-download phase to leave clean scrollback — one summary line with size, duration, and the cached file path — so I can revisit my init session without scrolling past a defunct progress bar and two redundant `Downloading to` / `Downloaded to` lines.
4. As a dither user, I want the `Batch text truncated to fit embedding context` warnings collapsed into a single count at the end, so the warning is visible once without spamming dozens of identical lines.
5. As a dither user, I want `dither init` to actually finish embedding every chunk rather than silently dropping the remainder when qmd's hidden 10-minute session timer fires, so my search results aren't unknowably incomplete.
6. As a dither user with a large library, I want the long-running embed work to run in a background daemon, so I can keep using my terminal while embedding completes.
7. As a dither user, I want to see live progress with current/total and an ETA during indexing and embedding, so I know how long to wait or whether to bail.
8. As an impatient dither user, I want a single Ctrl-C during init to disconnect me from the progress watch without killing the work, so I can do other things while the daemon keeps embedding.
9. As a dither user who Ctrl-C'd out, I want init to tell me how to check progress later (`dither status`) and how to cancel the running job (`dither index cancel`), so I have control without consulting docs.
10. As a dither user, I want `dither status` to show the daemon's current job with live progress and recent completed jobs, so a single command answers "what's dither doing right now?"
11. As a dither user who changed their mind, I want `dither index cancel` to actually stop the running job and remember my cancellation (so the daemon doesn't auto-resume the embed on next startup), so my cancel is meaningful.
12. As a dither user running `dither search` while embedding is still in progress, I want a one-line footer warning that some results may be missing, so I'm not confused when a known doc doesn't appear.
13. As a script author calling `dither init` in CI, I want the command to block until everything is fully ready by default, so subsequent commands in my pipeline run against a complete index.
14. As a script author with a strict CI time budget, I want `--no-wait` to dispatch init's work to the daemon and return immediately, so my CI can move on and check status later.
15. As a first-time dither user, I want init to write a welcome doc into my library demonstrating the `dither search` → `dither get` workflow, so I learn the core commands by exercising them on real data.
16. As a dither user who doesn't want the welcome doc, I want `--no-welcome` to skip writing it, so my library stays empty.
17. As a dither user, I want `dither init` to transparently auto-start the daemon (with a disclosure line) if it isn't already running, so I don't have to remember a separate setup step.
18. As a dither user, I want the daemon to transparently auto-resume unfinished embed work after a crash, so I don't have to manually recover from kernel panics or kill -9s.
19. As a dither user who cancelled an embed, I want the daemon to NOT auto-resume that cancelled embed when it next starts, so my explicit cancellation is honored across daemon restarts.
20. As a plugin author whose plugin promotes new files into a qmd collection, I want my plugin to neither deadlock nor fail when the daemon is mid-job, so my plugin's reindex either runs now or is silently deferred to a coalesced follow-up.
21. As a dither user whose commands collide with daemon work, I want a clear `qmd is busy: <theme> (started Xs ago)` message naming what's happening, so I never wonder why my command was refused.
22. As a dither user who closes the terminal mid-init, I want the daemon to keep running (SIGHUP detaches the watcher but doesn't kill the job), so closing a window doesn't lose minutes of embedding work.
23. As a dither user who left a daemon embedding overnight, I want the events log to be bounded in size (rotated past ~1 MB), so it doesn't accumulate unboundedly.

## Implementation Decisions

### Display polish

- The `confirm()` helper in `prompt.ts` clears 2 lines via `moveCursor(0, -2)` + `clearScreenDown` so consola's submit-frame echo (1 line of prompt + 1 line of trailing `\n` from `close()`) is fully wiped before we write our `✓ <label>: <value>` confirmation. Already shipped on a recent commit; the new spec confirms its rationale.
- `confirm()` callsites must use lowercase labels. `init.ts` changes `confirm("Library", …)` → `confirm("library", …)`. A JSDoc note on `confirm()` codifies the convention.
- `qmd`'s download UI (from `node-llama-cpp` via `ipull` via `stdout-update`) is left undecorated during the download because prefixing every line would push width past `process.stdout.columns`, causing terminal soft-wrap and stacked ghost frames in the bar redraw. Instead, when the download finishes, dither erases the entire captured block (tracked by counting newlines emitted during the wrapped stdout) and prints a two-line synthetic summary: line 1 with parsed size + duration (`✓ downloaded model weights (333MB in 2m)`), line 2 with the tildified gguf path indented two spaces. Regex parse falls back to a generic line if qmd reworded.
- A scoped console.warn filter (already shipped as `withTruncationFilter` in `progress.ts`) drops qmd's per-chunk `truncated to fit embedding context` warnings, counts them, returns the count for inclusion in the final summary.
- The Session-expired silent-skip bug is fixed by looping `store.embed()` until a call returns `chunksEmbedded === 0`. Each call gets a fresh `LLMSession`. The loop is owned by the daemon's embed job runner.

### Welcome doc

- Written to `<library>/welcome/welcome.md`. The `welcome/` subdir becomes a qmd collection automatically (library subdirs are collections per `store.ts:25-31`), so the doc is searchable immediately.
- Skip-if-exists idempotency: re-init never overwrites an existing welcome doc.
- Content (hardcoded): short intro, the `dither search '…'` / `dither get <id>` pattern, the cleanup instructions (`rm -rf <library>/welcome/` + `dither index update`).
- `--no-welcome` flag on `dither init` skips creating the doc + collection. When skipped, the next-action epilogue falls back to the original `dither plugin install <path>` line.

### Daemon-owned work

- `dither init` auto-starts the daemon if not running, with disclosure: `→ starting dither daemon…` precedes the spawn, `✓ daemon started (pid X)` or `✓ daemon already running (pid X)` confirms idempotently. The user learns a long-lived process now exists and that `dither daemon stop` halts it.
- The daemon is a **state reconciler**. On startup, on SIGHUP, and after each completed job, it inspects qmd state and the marker files and queues whatever needs doing. The same code handles fresh init, crash recovery, and on-demand triggers (e.g. `dither index update`).
- Reconciliation rules, in order:
  1. configured embed model not present → queue model-download
  2. `~/.dither/needs-reindex` marker present → queue full reindex (and delete the marker on completion)
  3. `getStatus().needsEmbedding > 0` AND `~/.dither/embed-disabled` marker absent → queue embed
- Each phase is a discrete job: acquires its theme-specific lock (`qmd-{download,index,embed}.lock`), emits a `job-started` event, runs, emits a `job-progress` event per qmd `onProgress` tick (debounced ~100ms), releases the lock, emits a `job-done` (or `job-cancelled` / `job-failed`) event.
- Embed runs the loop-until-empty pattern so the 10-minute session ceiling doesn't silently drop chunks.
- `dither index cancel` reads the active lock to identify the running theme, sends SIGTERM to the holder PID, writes the `embed-disabled` marker if cancelling an embed (so the next reconciliation doesn't re-resume what the user explicitly stopped), waits up to 5s for lock release, prints `✓ cancelled <theme>`.
- `dither index update` clears the `embed-disabled` marker (resuming embed eligibility), touches `needs-reindex`, sends SIGHUP to the daemon, exits 0.

### IPC

- **Hybrid model**: existing snapshot file (`statusSnapshotPath()`) keeps serving "current daemon state" queries (used by `dither status` to summarize daemon-overall). New `~/.dither/events.jsonl` append-only log carries streaming job progress.
- Event shape: `{ts, kind, jobId, type, …}` where `kind ∈ {"job-started","job-progress","job-done","job-cancelled","job-failed"}` and `type ∈ {"model-download","indexing","embedding"}`. Job-specific fields vary (`current`/`total` for progress, `sizeMb`/`durationMs`/`path` for download done, `chunks`/`truncated`/`durationMs` for embed done).
- Watcher (init, `dither status`) follows the log via pure-Node `fs.open` (read) + periodic `fs.fstat` (size check) + delta `fs.read`. No `fs.watch` — avoids macOS coalescing quirks. Polling cadence ~100ms.
- Rotation: daemon truncates the log to 0 bytes on startup. During a long-lived run, if appending would push the file past 1 MB, atomic `rename(events.jsonl → events.jsonl.old)` + start fresh. Two files maximum, ever.
- Daemon-dead detection in the watcher: if no events arrive in 5s AND the daemon PID is no longer alive, exit the watch with an error pointing at `dither status`.

### Locking

- Three per-theme lock files at `~/.dither/locks/qmd-{download,index,embed}.lock`. PID-only body (no JSON schema). Theme is encoded in the file name; elapsed is `fstat(mtime)`.
- Non-blocking acquire only. Existing `locks.ts:acquire()` already returns `null` on contention; no wait/retry loop added.
- A thin `qmd-locks.ts` wrapper exposes `tryAcquire(theme)` returning either a `LockHandle` or `{ busy: theme, startedAt }`, plus a `status()` aggregator.
- Read-side commands (`dither search`, `dither get`) never touch any lock. SQLite's own concurrency model handles read-during-write.
- Plugin behavior on contended `qmd-index.lock`: skip the reindex silently, `touch ~/.dither/needs-reindex`, continue. The promoted files remain on disk; only the index rescan is deferred. Daemon coalesces all deferred entries into one follow-up reindex.

### Init flow

1. Resolve library path (existing).
2. Run config + welcome doc + qmd-import discovery as today, then `saveConfig`.
3. Ensure daemon up via `startDaemon()` with disclosure lines (idempotent).
4. If `--no-wait`: print `→ dispatched. daemon will finish in background — dither status to check.` followed by the welcome / next-action epilogue. Exit 0.
5. Otherwise: open events log, seek to current end, follow. Render progress through the existing `progress.ts` (extended with per-job-type rendering). Install SIGINT / SIGHUP handlers that disconnect the watcher.
6. On detach: print the detach block (`✓ detached. dither status / dither index cancel`) followed by the welcome / next-action epilogue. Exit 0.
7. On watch-to-completion: print the welcome / next-action epilogue. Exit 0.
8. On daemon death detected: exit non-zero with a pointer at `dither daemon start` / `dither status`.

### Status

- `dither status` reads the snapshot for daemon overview + the events log (tail of last ~50 entries) for current/recent jobs, plus `existsSync` checks for the three locks and the marker files. One unified output.
- Layout when something is running:
  ```
  daemon  pid 12345 · up 2h
  
  current  embedding library  1240/1820 (68%) · started 3m ago · ~50s remaining
  recent
    ✓ indexing library  47 files · 4s ago
    ✓ model download    333MB · 2m 14s ago
  
  needs-reindex pending
  ```
- Layout when idle: similar but `current  none`.

### Flag conventions on `dither init`

- `--library <path>` — existing.
- `--no-download` — existing; skip model fetch.
- `--no-welcome` — new; skip welcome doc + collection.
- `--no-wait` — new; dispatch to daemon and return without watching. Default is wait (foreground watch).

All boolean flags follow the `--no-X` "skip the X step" family. No omnibus `--no-interactive` flag — the three behaviors (wait, progress style, prompt skipping) are independently composable.

## Testing Decisions

- A good test asserts external behavior (what the user / caller observes), not internal sequencing or method calls. Existing init tests in `init.test.ts` capture stdout and assert on output substrings — that pattern continues.
- Module-isolated tests:
  - **`events-log.ts`**: append/read roundtrip with a temp file; concurrent appends; rotation when the file crosses 1 MB; follow-mode with abort signal terminates cleanly. Prior art: `journal.test.ts` exercises a similar append-only-with-replay shape.
  - **`qmd-locks.ts`**: roundtrip acquire/release per theme; busy detection returns `{busy, startedAt}` matching the live mtime; stale-PID reclaim is covered by the underlying `locks.test.ts`.
  - **`daemon-jobs.ts`** (the state reconciler): given a synthetic on-disk state (model file present/absent, marker files present/absent, needsEmbedding > 0 or 0), assert the queued job sequence. Loop-until-empty embed: feeds a `store.embed` mock that returns 800 then 200 then 0 chunks across three calls, asserts three calls are made and the final summary aggregates correctly. Cancel path: SIGTERM mock → abort signal fires → embed-disabled marker is written → lock is released. Prior art: `daemon.test.ts` already mocks daemon lifecycle.
  - **`qmd-download-render.ts`**: feed canned qmd output (with `\r`-redrawn progress bar segments), assert the captured block is erased and the summary regex matches the size + duration + path correctly. Negative case: malformed qmd output → fallback summary line. No prior art; closest is `progress.test.ts` if added.
  - **`welcome-doc.ts`**: skip-if-exists; content shape (mentions `dither search` and `dither get`); not destructive on existing user content. Pure unit, no fixtures.
- Extended `commands/init.test.ts`:
  - TTY foreground watch path: simulate event-log entries arriving, assert progress rendering then final summary.
  - `--no-wait`: assert init exits after dispatch with the right epilogue lines.
  - SIGINT handler: assert detach block + epilogue print + exit 0 (no daemon kill).
  - `--no-welcome`: assert welcome doc is not written and `next:` falls back to the plugin-install line.
  - Non-TTY existing test (`--library required when not TTY`) remains green.
  - qmd auto-discover tests (existing) remain green.
- New `commands/status.test.ts`: assert the current/recent layout when feeding a synthetic events log and lock-existence state.
- New `commands/index.test.ts`: `dither index update` touches `needs-reindex`, clears `embed-disabled`, sends SIGHUP. `dither index cancel` sends SIGTERM to the mock holder PID, writes `embed-disabled` when cancelling embed, waits for lock release.
- End-to-end smoke is left to manual `dither init` runs (the real qmd download + embed pass is not test-suite-friendly: 330 MB download + minutes of embed).

## Out of Scope

- Routing every qmd write through the daemon's job queue (architecture C from Q10). The lock + marker file approach is sufficient for the stated user concerns and forward-compatible with this future refactor — the locks continue to exist as a crash-safety net.
- A dedicated `dither watch` command for tailing the events log standalone. The JSONL log makes this trivial to add later; the user-facing command is its own spec.
- Embed scheduling policies — priorities, throttling, time-window restrictions.
- Editor / docs-site live integration with the events log.
- Unix-socket IPC. The existing `daemon-control.ts` comment notes "Sockets remain a future option (see specs/daemon.md 'Filesystem coordination + signals' decision)" — this spec does not change that decision.
- Real-time interactive prompts beyond the existing consola text prompt for library path.
- The 30s lock-wait variant was considered and rejected; if the lock-or-skip + marker-bit pattern proves insufficient in practice, that's a future change.

## Further Notes

- The 10-minute session timeout in qmd's `LLMSession` (`@tobilu/qmd/dist/llm.js:1049`) is currently hardcoded with no SDK pass-through. The loop-until-empty fix sidesteps this without requiring a qmd patch. A future qmd version exposing `maxDuration` via `store.embed()` would let us pass through a longer value, but the loop pattern remains correct (and useful for incremental restartable embedding regardless).
- qmd's `node-llama-cpp` model download is hard-wired with `cli: true`; there's no SDK toggle to mute the bar. Stdout-capture + erase-on-completion is the only viable approach absent an upstream change.
- Snapshot atomic-write semantics in the existing daemon need verification during implementation — if the snapshot is not currently written via tmp-file-rename, the same change adds it. Cost: trivial.
- The events log format is versionable by introducing a `v: number` field; today's events omit it (implicit v1). Forward-compatible.
- The single `needs-reindex` marker coalesces deferred work and is intentionally coarse-grained — per-collection granularity adds little because qmd's `update()` is idempotent and fast on unchanged files.
