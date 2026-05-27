# plugin-run-daemon-only

## Problem Statement

`runPlugin()` is called from two completely different process contexts — the CLI (`d plugin run X`) and the daemon (scheduled / watch / refire fires). Both acquire the same lock, spawn the same Deno child, manage the same journal. The CLI ends up wearing three hats at once: **invocation** (deciding to run), **supervision** (owning the child process and finalizing state), and **observation** (showing live progress). Ctrl-c in the CLI kills the supervisor mid-run, leaving the journal half-written, the run permanently displayed as "running", and a confusing UX. Detach via `--detach` re-spawns yet another CLI process to wear the same three hats. Three call patterns, two failure modes, one supervisor role split across whoever happened to call `runPlugin` first.

## Solution

Decomplect the three concerns. The **daemon is the sole supervisor**; the CLI becomes a thin client.

- **Invocation** = "kick" — a filesystem message in `<home>/kicks/<plugin>.json`, written by the CLI, picked up by the daemon. Same idiom as `refires/` and the watch inbox.
- **Supervision** = the daemon's existing `fireWithSuppress` pipeline running `runPlugin()`. The daemon is the only caller in production.
- **Observation** = the existing `tailRun(runId)` / `followRun(runId)` machinery, called by N concurrent clients. Read-only.

`d plugin run X` becomes: ensure daemon is up (auto-start), pre-check that X isn't already running, write a kick, SIGUSR1 the daemon, tail the journal until `result.json` appears. Ctrl-c during the tail just stops tailing — the daemon owns the run. `--detach` skips the tail step entirely. Internally, the ~300-line `runPlugin` function splits into three deep modules (`Supervisor`, `Promotion`, `Kicks`) and a thin orchestrator; the lock moves into `fireWithSuppress` so `runPlugin` no longer knows about locks at all.

## User Stories

1. As a plugin developer, I want `d plugin run X` to behave the same as before — print progress, finish, exit — so the everyday workflow is unchanged.
2. As a user who closed the terminal mid-run, I want the run to finish anyway (and result.json to land), so I never see "stuck at running forever" again.
3. As a user, I want ctrl-c during a foreground `d plugin run X` to just stop my tail — not kill the run — and print a tail-later hint, so accidental key presses don't lose work.
4. As a user, I want `d plugin run X --detach` to kick the run and return immediately, so I can fire long syncs from a script without waiting.
5. As a user who hits `d plugin run X` twice, I want a clear "already running — tail with ..." message and a clean exit, so I'm not silently spawning duplicates.
6. As a daemon-less developer running plugins for the first time, I want the daemon to auto-start invisibly, so I don't have to learn a separate command before using `plugin run`.
7. As a power user, I want `--env=KEY=VAL`, `--allow-net=host`, `--file=ID=path`, `--allow-collection=…` overrides to still work, so ad-hoc testing of new grants stays fast.
8. As a plugin author iterating with `--verbose`-style live stderr, I want the default tail to show plugin stderr as it happens (because the journal already records it), so I don't need a separate verbose flag.
9. As a user reading run history, I want runs that died with their CLI to be classified `interrupted` not `running`, so the listing isn't misleading (Phase A — already shipped, this spec keeps it correct).
10. As a tester / programmatic caller, I want `runPlugin()` still importable for unit-level use, so tests don't need a real daemon.
11. As a future maintainer, I want each of (spawn-and-supervise, validate-and-promote, kick-IPC) to be a separate testable module, so changing one doesn't ripple into the others.
12. As a daemon, I want to be the single owner of plugin-lock acquisition, so the lock's invariant is co-located with the only process that can violate it.
13. As a user, I want SIGUSR1 to be the only new signal in play, so SIGHUP's existing "reload" semantics stay clean.
14. As a user with a stuck plugin (rare), I want to still be able to `kill <childPid>` (PID surfaced via `d plugin runs <id>`) and have the run close cleanly as `fail`, so I'm never trapped.
15. As an observer of the codebase, I want `<home>/kicks/<plugin>.json` to read and write exactly like `<home>/refires/<plugin>.json`, so the project pattern stays singular.

## Implementation Decisions

**Auto-start the daemon.** `d plugin run X` always ensures the daemon is running via the existing `startDaemon()` path; no opt-in, no fallback to in-CLI supervision. The CLI never spawns plugin children itself.

**Kicks live alongside refires.** New `<home>/kicks/<plugin>.json` directory mirroring the shape of `refires/` (one file per plugin). Payload: `{ runId, kickedAt, overrides? }`. New tiny module `kicks.ts` next to `refire.ts` — `readKick`/`writeKick`/`clearKick`/`listKicks`. Refires unchanged; the two are kept semantically separate (kicks = user-initiated "run NOW"; refires = plugin-initiated reschedule + backoff retry).

**CLI assigns the runId.** `generateRunId(plugin)` is exported from `run-log.ts` and called by the CLI before writing the kick. The kick payload carries that runId. The daemon's `openRun` gains an optional pre-supplied id parameter; on a kick fire, the daemon uses that id rather than minting one. CLI knows the journal path before the daemon has read the kick — no handshake polling.

**Reject duplicate fires.** If a kick file already exists for X, or the per-plugin lock is held, `d plugin run X` prints `X is already running — tail with 'dither plugin runs X'` and exits 1. No coalesce, no queue.

**Daemon notification: SIGUSR1.** After writing the kick, the CLI sends SIGUSR1 to the daemon (PID from the existing pidfile). The daemon installs a SIGUSR1 handler that calls `scanKicks()` — one `readdir` of `<home>/kicks/`, per-file: read JSON, fire via `fireWithSuppress`, unlink. POSIX coalesces multiple signals into one delivery; `scanKicks` processes every pending kick on each invocation, so coalescing is correct. SIGUSR1 is unused by the existing daemon (SIGTERM / SIGINT / SIGHUP only). On startup, the daemon also drains `kicks/` once to recover any orphaned-during-restart kicks (mirrors `refirer.reload()`).

**Default tail; `--detach` skips it.** `d plugin run X` defaults to kick + tail. Ctrl-c during tail just stops tailing and prints `(detached — still running, tail with 'dither plugin runs X')`. The run continues in the daemon either way. `d plugin run X --detach` writes the kick + signals + prints the runId + exits immediately — same end state, just without the brief tail. Same flag name as today.

**`runPlugin` decomposes into three deep modules.**

- **`Supervisor`** — owns `spawn` + stderr line-buffering + NDJSON control-message parsing (progress / reschedule) + FDA/EPERM sniffing + childPid recording. One entry point taking a journal handle, plugin dir, env, allow-args; returns `{exitCode, lastReschedule, fdaPath?}`. No knowledge of grants, promotion, or refire.
- **`Promotion`** — `planPromotion` + `copyAdded` + the post-promote index-lock dance. One entry point `promote({runDir, plugin, config, grants, journal}) → {added: string[], reindexDeferred: boolean}`.
- **`Kicks`** — `<home>/kicks/<plugin>.json` filesystem mechanism (mirrors `refire.ts`'s shape) plus a `signalDaemon()` helper.

After the split, `runPlugin` is ~80 lines: load grants + manifest, open journal, call Supervisor, call Promotion, decide refire outcome via `decideRunOutcome`, close journal. The orchestration is finally legible.

**Lock acquisition moves to `fireWithSuppress`.** Today `runPlugin` acquires the lock on entry and releases on exit. The lock is the daemon's invariant — only the supervisor needs it. Moving acquisition into `fireWithSuppress` (the daemon's fire entrypoint) means `runPlugin` doesn't import locks at all and becomes a pure orchestration function. The four daemon-side fire sources (Scheduler, Watcher, Refirer, Kicker) all funnel into one lock-acquiring entry point.

**Per-run overrides in the kick payload.** `overrides?: { env?, envRefs?, files?, net?, collections?, verbose? }`. Daemon reads, passes to `runPlugin`. Override fields mirror today's `RunOptions` overrides — no shape change at the `runPlugin` boundary.

**No cancel command.** Stuck runs are addressed by fetch timeouts inside plugins. If a truly stuck run needs to die, the user can `kill <childPid>` (PID surfaced via `d plugin runs <id>`). Daemon sees the exit, journal closes with `status: "fail"`. Cancel-as-a-command is a small future addition mirroring kicks (`cancels/<plugin>` filesystem message + same SIGUSR1 channel) if operational experience demands it.

**No migration code.** Old `--detach` re-spawn path and old in-CLI supervision path are deleted outright. No fallback flag, no opt-out env. Filesystem layout adds `<home>/kicks/` but doesn't change any existing files.

**Deletions:**

- The CLI's `runPlugin()` direct call site in `commands/plugin.ts` and the entire surrounding spawn-supervision branch.
- `--detach`'s re-spawn-the-CLI implementation (the flag name stays; the implementation collapses to "skip tail and exit").
- `onProgress` callback field on `RunOptions` — no consumer after the CLI tails the journal.
- `--verbose` flag — equivalent behavior is the default tail (which renders `kind: "stderr"` events live).
- `PLUGIN_ALREADY_RUNNING` error code — replaced by a CLI-side pre-check that exits cleanly before writing the kick.

**Pattern alignment.** The implementation conforms to the project patterns now documented in `AGENTS.md` under "Project Patterns" — filesystem-message channel shape, fire-source symmetry (Kicker joins Scheduler/Watcher/Refirer as the fourth source whose callback is `fireWithSuppress`), CLI auto-start, run journal lifecycle. No new mechanisms; just one more channel that looks like every other one.

## Testing Decisions

A good test here is one that exercises a module's external behavior — what it does for callers — without binding to its implementation. Unit tests use fake `fetch` / fake `spawn` so no real network, no real subprocess; integration tests run a real `runPlugin` against a tiny fake plugin script.

Tested modules:

- **`Kicks`** — write/read/clear/list contract. Pure I/O. Assert: write+read round-trips the payload; clear unlinks; list returns sorted entries; unsafe plugin names throw. ~10 tests. Prior art: `refire.test.ts`.
- **`Supervisor`** — fake `spawn` returning a fake child. Assert: correct Deno argv (allow flags, import map, env vars), control-message parsing (progress + reschedule), childPid recorded into journal, FDA path sniffed from EPERM stderr lines, non-zero exit reflected in result, stderr lines journaled as `{kind: "stderr"}`. ~12 tests. Prior art: existing `plugin-host.test.ts` patterns.
- **`Promotion`** — uses real fs; tiny temp run-dir with sample md files. Assert: valid frontmatter promotes, mismatched `source` rejects, missing grant rejects, index-lock-busy path writes the `needs-reindex` marker and journals `reindex-deferred`. ~6 tests.
- **`runPlugin` orchestrator** — fakes Supervisor + Promotion. Assert: success path closes journal with `ok`; failure path calls `restoreInflight` and closes with `fail`; reschedule writes the refire row; clean exit clears refire + inflight. ~6 tests.
- **End-to-end smoke** — one integration test: write a kick file, SIGUSR1 a real in-process daemon, assert a run completes and `result.json` lands with the expected runId. Uses an existing trivial test fixture plugin. ~1 test, gated to skip on CI without a usable Deno binary.

Skip:
- `daemon.ts`'s SIGUSR1 wiring itself (one-line `process.on` registration — covered by the end-to-end smoke).
- The CLI's kick + tail path beyond the e2e — citty-driven CLI behavior is already covered by `commands/plugin.test.ts`'s existing structure; the new path is small and changes only what gets invoked.

## Out of Scope

- **Cancel command** (`d plugin cancel X`). Useful future addition; mirrors kicks. Not in this spec.
- **Coalesce-don't-reject behavior** for the second `d plugin run X`. We chose reject for code economy; a `--wait` flag could add the "tail the existing run" behavior later.
- **Subsecond kick latency.** SIGUSR1 plus a single `readdir` is the chosen mechanism. fs.watch on `kicks/` would shave milliseconds but isn't justified.
- **Cross-host CLI** (running `d plugin run` against a daemon on another machine). Kicks are local-filesystem; no socket / no network protocol.
- **Plugin-level timeouts as a CLI flag.** Plugin authors add `AbortSignal.timeout()` to their fetches; the daemon doesn't enforce wall-clock timeouts.
- **Migration story.** No users yet — old paths are deleted outright.
- **Refire row coalescing with kicks.** A pending refire and an inbound kick produce two fires (the refire fires when its timer pops; the kick fires now). They share the lock, so they queue rather than collide. Not load-bearing.

## Further Notes

- The runId pre-assignment by the CLI works because `generateRunId` uses a 4-byte random suffix per timestamp-second — collisions with the daemon's own minting are astronomically unlikely (the daemon retries 3× on `EEXIST` for `mkdir(historyDir/runId)` anyway, `run-log.ts:438-447`).
- `signalDaemon()` reads the existing PID file (`pidFilePath()`) — no new state. If the PID file is missing or stale, the CLI's `ensureDaemon()` step has already restarted the daemon, so by the time we send the signal there's a live process.
- The daemon's startup `scanKicks()` drain after a crash means kicks written while the daemon was down don't get lost — same robustness pattern as `refirer.reload()` (`refirer.ts:22-29`) and `recoverOrphanInflight()` (`inbox.ts:148-164`).
- Phase A (`childPid` in `manifest.json` + `isPidAlive` check in `readSummary`) still earns its keep: it catches the rare case of a daemon crash mid-run, classifying that run as `interrupted` instead of permanently `running`.
- The choice of SIGUSR1 rather than SIGHUP avoids overloading reload semantics. SIGHUP today triggers config/grants/refires reload + qmd reconcile; adding "scan kicks" would make SIGHUP do too many things.
- `runPlugin` stays importable for tests (Story 10). Production callers reduce to one: `fireWithSuppress` inside the daemon.
- The `Supervisor` extraction is the highest-leverage internal change — it isolates the most error-prone code (spawn lifecycle + stderr parsing) behind a small interface that's easy to fake in tests.
- After the change, every fire — manual kick, schedule, watch, refire — flows through identical machinery: source callback → `fireWithSuppress` → lock acquire → `runPlugin(name, trigger)` → Supervisor → Promotion → journal close → refire row update → lock release. One path, four entry points. Symmetric.
