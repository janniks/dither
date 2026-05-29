# P1 cleanup — deferred items

Items grilled during the 2026-05-29 audit session and deliberately deferred from the first cleanup pass. Locked items are in `plans/cleanup-p1.md` (or whatever `/create-plan` names it). Background: `notes/p1-code-conventions-audit.md`, `notes/ipc-landscape.html`, `notes/ipc-graph.html`.

## #2 — Plugin-install facade

- **What:** Graph shows `plugin-install.ts` both `value-import`s AND `re-export`s from `plugin-install-interactive.ts`. Half-finished refactor; consumers don't know which to import.
- **Where:** `packages/cli/src/plugin-install.ts` + `packages/cli/src/plugin-install-interactive.ts`
- **Fix:** Pick a direction — make `plugin-install.ts` a pure facade (only re-exports, all logic in `plugin-install-interactive`) OR fold them back into one file. Per `llm-decisions.md` phase-2 the canonical surface is `installPlugin(opts)`, which argues for facade.
- **Why deferred:** Independent of other items; small win on its own; wait until the command-prefix rename lands so we don't fight import churn.
- **Effort:** S–M.

## #7 — `commands/status.ts:34-42` 4-level ternary

- **What:** Hardest-to-read formatter in the codebase. 4-level nested ternary for status-line rendering.
- **Where:** `packages/cli/src/commands/status.ts:34-42`
- **Fix:** Lookup table or early-return helper.
- **Why deferred:** Purely cosmetic; not worth fighting for in the first pass.
- **Effort:** XS.

## #9 — `home()` reads env every call

- **What:** `home.ts:26` reads `process.env.DITHER_HOME` afresh on every call. Tests need `await import("./home")` workaround. `_resetHomeWarningLatch` at `:37` exists for tests only.
- **Where:** `packages/cli/src/home.ts:17, 26, 37`
- **Fix:** Add docstring explaining the pattern + when tests must dynamic-import. **Don't memoize** — that would break the env-override contract that tests rely on.
- **Why deferred:** Trivial; bundle with the next pass that touches `home.ts`.
- **Effort:** XS.

## #10 — `daemon-control.ts` vs `daemon-client.ts` naming

- **What:** Sibling files with overlapping verbs. `daemon-control.ts` = local-process helper (pid, spawn, kill, probe). `daemon-client.ts` = event-stream RPC wrapper. Names don't reveal which side of the wire.
- **Where:** `packages/cli/src/daemon-control.ts`, `packages/cli/src/daemon-client.ts`
- **Fix:** Consider `daemon-process.ts` for control (matches "process" verb cluster), keep `daemon-client.ts`. Could also defer until a real unix socket lands (parked in `architecture.md`).
- **Why deferred:** Naming bikeshed without concrete pain; revisit if/when socket IPC is unparked.
- **Effort:** S.

## #12 — `config.ts` audit

- **What:** Complexity 43, fanIn 17 (highest fanIn after `home.ts`). Highest blast radius in the codebase.
- **Where:** `packages/cli/src/config.ts`
- **Fix:** Read it once, decide if complexity is essential or accidental. Not a refactor yet — research first.
- **Why deferred:** Research, not a known refactor. Promote to an action item only if the audit finds accidental complexity.
- **Effort:** S to audit; refactor TBD.

## #13 — Split `daemon-control.ts`

- **What:** Complexity 52, 12 exports. Mixes pid-file I/O, spawn, kill, probe, snapshot-read.
- **Where:** `packages/cli/src/daemon-control.ts`
- **Fix:** Split into `daemon-pid.ts` (read/write/verify pidfile) + `daemon-spawn.ts` (fork + lifecycle) + `daemon-probe.ts` (liveness checks). Keep `daemon-client.ts` separate (event-stream side).
- **Why deferred:** Changes character with the heartbeat removal (#8 locked) — `probeDaemon` simplifies, freshness window goes away, and #15 may merge the pid file into `daemon.json`. Wait until those settle, then re-evaluate whether the split still makes sense.
- **Effort:** M.

## #14 — `commands/init.ts` phase decomposition

- **What:** Second-most-coupled command (fanOut=10). 8 `else if` ladders blur phase boundaries.
- **Where:** `packages/cli/src/commands/init.ts`
- **Fix:** Extract each phase as a named function (`promptLibrary`, `prefetchModel`, `writeWelcomeDoc`, `kickReconcile`). `init` body becomes a linear sequence of awaits.
- **Why deferred:** Pairs naturally with the broader commands/ rework; revisit after the command-prefix rename + plugin.ts split lands so the conventions are established.
- **Effort:** M.

## #15 — Merge `dither.pid` + `status.json` → `daemon.json`

- **What:** Two files for daemon identity; one was rewritten 1Hz, the other rarely.
- **Where:** `packages/cli/src/daemon.ts`, `daemon-control.ts`, `commands/status.ts`
- **Fix:** Single file `{pid, token, startedAt, lastUpdated, ...}` written on state changes.
- **Why deferred:** Changes character now that #8 killed the heartbeat. The pid+status separation was load-bearing for shutdown safety; with event-driven writes the merge is less interesting (both files are now low-frequency). Worth a focused grill before committing.
- **Effort:** M (with the heartbeat already gone, simpler than before).

## #16 — Merge `history/<runId>/{manifest,result}.json` → `run.json`

- **What:** Two files per run for what's conceptually one record (header + footer).
- **Where:** `packages/cli/src/run-log.ts`, `plugin-run.ts`
- **Fix:** Single file written tmp+rename twice (start + end). Saves one file per run.
- **Why deferred:** Touches the run journal which is ADR 0001 territory; safer to land the other run-log changes first (#5 ENOENT, the truncateGlobal bug fix) and then revisit.
- **Effort:** S.

## Rejected during grilling (not deferred — explicitly not doing)

- ~~Rename `daemon-jobs.ts` → `reconciler.ts`~~ — "Reconciler" is invented vocabulary; `daemon-` prefix tells humans more than a domain term they don't recognize.
- ~~Encapsulate `run-log` writers via class/factory~~ — singleton state is fine for a single-process CLI; just fix the `truncateGlobal` Maps bug + document the pattern.
- ~~Convert `Scheduler`/`Watcher`/`Refirer` from classes to factory records~~ — they pass the user's "tight scope + explicit interface + no aliased state" test; add explicit TS interfaces, keep classes.
- ~~Slow heartbeat (1Hz → 60s)~~ — went all the way to no heartbeat at all; liveness via pid file + kill(0).
- ~~Fold `needs-reindex` into kicks; eliminate markers~~ — markers earn their keep as cheap per-iteration `existsSync` probes; framed in CONTEXT as "lazy signals."
- ~~Move `commands/plugin-oauth.ts` out of `commands/`~~ — stays as `command-plugin-oauth.ts` (sibling under commands/) once the prefix rename lands.
