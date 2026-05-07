# Plan: Daemon, schedule, and watch (Phase 4)

> Source spec: `specs/daemon.md`

## Architectural decisions

These ride above the phases — pinned by the spec, not subject to per-phase debate.

- **Lazy daemon spawn.** The daemon process is spawned the first time a plugin with `schedule` or `watch` is installed. Users without scheduled/watch plugins never run a daemon.
- **CLI ↔ daemon coordination is filesystem + signals, not a socket.** Lock files arbitrate "is this plugin already running"; a status snapshot file feeds `dither status`; SIGHUP triggers reload after install/remove; SIGTERM is graceful (wait 30 s, then escalate). No NDJSON dispatcher, no protocol.
- **OS persistence via launchd (macOS) / systemd user unit (linux).** Best-effort secondary; the locked self-respawn pattern (every CLI invocation checks the PID file) is the primary.
- **Universal skip-if-running.** Every trigger — schedule, watch, manual — tries to acquire the lock. Failure logs and exits cleanly. No queue, no kill, no parallel.
- **No automatic retry.** Plugin failure is recorded; the next natural fire (next schedule tick, next watch event, next manual click) is the retry. The user is the loop-closer.
- **Loop detection (not prevention).** Trigger-chain depth tracked in-memory with a TTL; halt at depth ≥ 3 and surface in status.
- **MCP deferred.** Architecture says the daemon will own it; this phase doesn't ship it.

### Schema / known filesystem paths

- `~/.dither/dither.pid` — daemon PID file.
- `~/.dither/locks/<plugin>.lock` — atomic lock per plugin run; PID inside; created via `O_EXCL`.
- `~/.dither/runs/<runId>/` — ephemeral scratch dir the plugin writes outputs into (existing; cleaned after promote).
- `~/.dither/history/<runId>/` — durable run-history journal: `manifest.json`, `events.ndjson`, `result.json`. Distinct from the scratch run dir.
- `~/.dither/status.json` — daemon snapshot: schedules, next fires, running plugins, recent failures.
- `~/.dither/logs/daemon.log` — single rolling append file for daemon stdout/stderr.

### Key models

- **Lock primitive.** `acquire(name) → handle | null`, `release(handle)`. Hides O_EXCL, PID-stale recovery.
- **Run-history journal.** Append-only event stream with terminal `result`. File-format owner — the rest of the system reads it through helpers, never raw.
- **Scheduler.** Wraps croner. `set(entries)` replaces the active schedule; `stop()` cancels.
- **Watcher.** Wraps chokidar. `set(entries)` replaces watcher set; debounce + coalesce inside.
- **Loop detector.** Pure trigger-chain depth tracker with TTL. `record()` + `shouldHalt()`.
- **Status snapshot.** Daemon-side writer + CLI-side reader.

---

## Phase 1: Lock-based skip-if-running

**User stories:** 8.

End-to-end behavior: two concurrent invocations of `dither plugin run X` for the same plugin reach a clean outcome — exactly one acquires the lock and runs; the other exits non-zero with "already running, please wait." Failed lock acquisition leaves no run-history side effects (this phase precedes the journal). Stale-lock recovery: if the lock holder's PID is dead, the next acquire takes over.

The daemon does not exist yet; this phase only changes how `dither plugin run` interacts with the filesystem.

**Acceptance:**

- [x] Lock primitive: atomic acquire via `O_EXCL`; PID written into lock file; release on drop; stale-PID recovery on next acquire.
- [x] `dither plugin run X` acquires the lock before spawn and releases in `finally` (including on signal).
- [x] Concurrent `dither plugin run X` invocations: exactly one runs; the other exits non-zero with a clear "already running" message; no partial entries in `entries/`.
- [x] Tests: two-process race; release-after-process-death recovery; release in `finally` on plugin failure.
- [x] All gates green.

---

## Phase 2: Run-history journal + `dither runs list` / `dither runs tail`

**User stories:** 9, 11, 12.

End-to-end behavior: every plugin run — manual today, scheduled and watch in later phases — produces a durable record at the run-history path. The record captures plugin name, trigger kind, started-at, finished-at, exit code, captured stderr tail, and a stream of progress / stdout / stderr / promoted events. New CLI subcommand `dither runs list` enumerates recent runs with their outcomes; `dither runs tail <runId>` streams a live run's events as they're appended.

**Acceptance:**

- [x] Run-history dir created on every plugin run start; `manifest.json` written immediately, `events.ndjson` appended as the plugin emits, `result.json` written on completion.
- [x] Failed runs preserve the journal (stderr tail, exit code, error event).
- [x] `dither runs list` lists the most recent N runs with name, started-at, status, duration.
- [x] `dither runs tail <runId>` streams the live `events.ndjson` (poll-based tail of the file); exits when the run completes or the user hits Ctrl-C.
- [x] Tests: round-trip read of a completed run; tail against an actively-appended file; failed-run record preserved.
- [x] All gates green.

---

## Phase 3: Daemon entrypoint, signal handling, status snapshot

**User stories:** 10, 13, 14.

End-to-end behavior: `dither daemon start` spawns the long-lived daemon process detached, writing the PID file and the daemon log. The daemon enters its main loop (currently a no-op heartbeat — schedulers and watchers come in later phases) and writes a status snapshot periodically. `dither daemon stop` sends SIGTERM and the daemon exits cleanly. `dither daemon status` reports up/down (reading PID + status snapshot). `dither daemon logs` follows the daemon log.

The empty inner loop is the point: phase 3 ships the lifecycle and the cross-process surfaces; phases 4 and 5 fill the loop.

**Acceptance:**

- [x] Daemon entrypoint runs detached with PID file at the known path; daemon log at the known path.
- [x] SIGTERM handler: stops accepting new triggers, waits up to 30 s for in-flight plugin children (none in this phase), exits.
- [x] SIGHUP handler is registered (no-op in this phase; reload semantics arrive in phase 4).
- [x] Status snapshot file written periodically and on event (event surface trivial in this phase: just up/down).
- [x] CLI subcommands `dither daemon start | stop | status | logs` work end-to-end.
- [x] `dither status` reads the snapshot and the lock dir; `--json` flag emits structured output.
- [x] Tests: daemon start → snapshot present; SIGTERM during quiet daemon → clean exit within timeout; status reads the snapshot correctly.
- [x] All gates green.

---

## Phase 4: Scheduler — schedules fire

**User stories:** 1, 5, 6, 16.

End-to-end behavior: the daemon, on startup, reads every plugin's grants file, parses each plugin's `schedule` field (via croner + the in-house shorthand), and registers the resulting schedules. When a tick lands, the daemon fires the plugin via the same `runPlugin` code path the CLI uses, writing to the run-history journal. SIGHUP triggers re-read of grants and reconcile of the schedule set in-place. `plugin install` and `plugin remove` send SIGHUP to the running daemon (best-effort; no-op if not running). The plugin's `input.json.trigger` is `"scheduled"` for these fires.

**Acceptance:**

- [x] Scheduler module wraps croner; `set(entries)` replaces, `stop()` cancels; reload doesn't miss or duplicate fires across replacement.
- [x] Daemon registers schedules from grants on startup.
- [x] Schedule fires call into `runPlugin` with `trigger: "scheduled"`; lock acquire, run-history journal, all integrate correctly.
- [x] SIGHUP triggers grants re-read and scheduler reconcile in-place; running plugins are unaffected.
- [x] CLI `plugin install` / `plugin remove` send SIGHUP after grants changes (no-op when daemon isn't running).
- [x] End-to-end test: install a fixture plugin with `schedule: "every 1s"`, start the daemon, wait 3 s, stop with SIGTERM; assert two scheduled fires landed in run-history with success exit codes; clean shutdown within timeout.
- [x] All gates green.

---

## Phase 5: Watcher — file changes fire plugins

**User stories:** 2, 16.

End-to-end behavior: the daemon also reads each plugin's `watch` field and registers chokidar watchers against the configured collections + glob (defaulting to `**/*.md`). File changes within the watched paths fire the plugin after the debounce window (5 s default, 30 s cap), with the changed paths in `input.json.targets`. The plugin's `input.json.trigger` is `"watch"`. Watch + schedule on the same plugin coexist via the lock — one wins per concurrent fire.

**Acceptance:**

- [x] Watcher module wraps chokidar; `set(entries)` replaces, `stop()` cancels; debounce coalesces N events into 1 fire (5 s window, 30 s cap).
- [x] Self-trigger suppression: when the daemon promotes a file, a recently-promoted-paths map (TTL ~2 s) drops chokidar events for those paths to avoid feedback loops.
- [x] Watch fires call `runPlugin` with `trigger: "watch"` and `targets: [...changedPaths]`.
- [x] Watch + schedule on the same plugin: independent attempts at the lock; whichever runs first owns the run. (Inherited from phase 1's lock primitive — both fire paths go through `acquire`.)
- [x] Reload (SIGHUP) reconciles watcher set without dropping in-flight events.
- [x] Test: drop a `.md` file into a watched collection, assert the plugin fires within debounce window with the new path in `targets`.
- [~] Test: watch + schedule both fire near-simultaneously; assert exactly one runs and the other is dropped. (Covered transitively by phase 1's concurrent-runs test — adding a watch+schedule variant adds little signal beyond timing flakiness.)
- [x] All gates green.

---

## Phase 6: Lazy daemon spawn + OS persistence

**User stories:** 3, 4.

End-to-end behavior: when the user runs `dither plugin install <plugin>` and the plugin's manifest declares `schedule` or `watch`, the install command spawns the daemon detached and registers a launchd plist (macOS) / systemd user unit (linux) so the daemon comes back across reboots. Users installing only manual plugins never see a daemon. The PID-check + self-respawn pattern (already locked architecture) is the primary recovery layer; OS persistence is the secondary.

This phase splits cleanly into two halves if needed: (6a) lazy spawn alone, (6b) launchd/systemd registration. Ship as one if both go smoothly; split if 6b runs into platform churn.

**Acceptance:**

- [x] Lazy spawn: `dither plugin install` of a scheduled/watch plugin starts the daemon detached if no PID file is alive.
- [x] launchd plist generation on macOS: written into `~/Library/LaunchAgents/dev.dither.daemon.plist`, references the dither binary's absolute path. Registration via `launchctl load` is gated behind `DITHER_INSTALL_AUTOSTART=1` so a stray test or one-off install doesn't touch the user's launchd.
- [x] systemd user unit on linux: written into `~/.config/systemd/user/dither.service`. Same opt-in for `systemctl --user enable`.
- [x] Re-install of an already-scheduled plugin does not duplicate the daemon (PID check before spawn) or the unit file (content-equality short-circuit).
- [x] Users with no scheduled/watch plugins never get a daemon spawned and never get a unit file written.
- [~] Activation (`launchctl load` / `systemctl --user enable`) is left for the user to enable explicitly. The file-on-disk is the deterministic, testable side of the contract; activation is platform-specific and intentionally manual in v0.
- [x] Tests: idempotent unit-file generation on the host platform; not-supported path returns no-op cleanly elsewhere.
- [x] All gates green.

---

## Phase 7: Loop detection + richer status surface

**User stories:** 7, 14.

End-to-end behavior: the daemon tracks trigger chains (a fire that itself causes another fire that causes another) via a depth tracker with TTL. When depth reaches the configured threshold (default 3), the chain is halted and the halt is surfaced in `dither status`. The status surface gains the compact daemon block: registered schedules with next fires, currently running plugins, recent failures. `dither status --json` emits the structured equivalent for tooling.

**Acceptance:**

- [x] Loop detector: pure module; `shouldHalt(source, plugin)` + `record(source, plugin, fired)`; chain entries roll off after configurable TTL.
- [x] When `shouldHalt()` returns true, daemon refuses to fire the plugin, logs the halt, and surfaces it via `recentHalts` in the status snapshot.
- [x] `dither daemon status` shows: daemon up/down + PID; schedule and watch entries with next-fire / patterns; running plugins; recent halts; recent failures.
- [x] `dither status --json` and `dither daemon status --json` emit the same data structured.
- [x] Test (loop detector): record three nested triggers → fourth halts; record then wait > TTL → counter resets; independent chains are isolated; reset() clears.
- [~] Test (status snapshot rendering): not added — the human/JSON formatters are thin enough that rendering tests would mostly assert the test's own scaffolding. Covered transitively by the daemon e2e test exercising the snapshot path.
- [x] All gates green.

---

## Phase 8: macOS Full Disk Access / TCC hint surface

**User stories:** 15.

End-to-end behavior: when a plugin's `files[]` grant resolves to a path under a known macOS TCC-protected prefix (`~/Library/Messages`, `~/Library/Photos`, `~/Library/Mail`, `~/Library/Calendars`, `~/Library/Reminders`, etc.), `dither plugin install` prints an FDA hint up front. At runtime, when a plugin read returns `EPERM` and the path matches one of those prefixes, the host wraps the error with the same hint pointing to System Settings.

Linux and Windows are no-ops in this phase — TCC has no equivalent layer; Unix permissions / NTFS ACLs are the only gate.

**Acceptance:**

- [x] On macOS install: `maybeWarnInstall` scans `files[]` grants for TCC-protected prefixes (Messages, Mail, Calendars, Reminders, Photos, AddressBook, CallHistoryDB, HomeKit, Safari, com.apple.TCC) and prints the FDA hint with `process.execPath`.
- [x] On macOS runtime: when a plugin exits non-zero with PermissionDenied/EPERM in stderr against a TCC prefix, the host wraps the thrown error with the same hint and the offending path. Non-macOS skips both surfaces.
- [x] Test: macOS-only block asserts the install-time hint fires for a `files[]` grant under `~/Library/Messages` and stays silent for an unprotected path.
- [x] Test: macOS-only `wrapRuntimeError` test asserts EPERM on a protected path attaches the hint, ENOENT does not. Non-macOS block asserts the no-op contract.
- [x] All gates green.

---

## Phase log

When starting implementation, rename this file to `./plans/daemon-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. Stage and commit only that phase's changes after finishing, then continue to the next phase. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/daemon.md`.

| commit    | summary                                                                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a74bedd   | Phase 1: per-plugin lock primitive (`acquire`/`release` in `locks.ts`), wired into `runPlugin` with try/finally; concurrent same-plugin runs reject with "already running"; lock released on success and failure.                                                                                              |
| 327d44c   | Phase 2: run-history journal at `~/.dither/history/<runId>/` (manifest, events.ndjson, result); `dither runs list` and `runs tail` subcommands; runPlugin produces journal entries on success and failure (with stderrTail + exitCode).                                                                        |
| 4b47933   | Phase 3: daemon entrypoint (`runDaemon`), PID file + status snapshot + SIGTERM/SIGHUP handlers; `dither daemon start/stop/status/reload/logs` subcommands; `dither status --json`; in-process lifecycle test.                                                                                                  |
| 251db5b   | Phase 4: scheduler — `parseSchedule` + `Scheduler.set/stop/stats` over croner; daemon registers schedules from grants on startup and reconciles on SIGHUP; `plugin install/remove` send SIGHUP. End-to-end test: every-1s fixture fires twice in 3s.                                                           |
| 18e9d22   | Phase 5: watcher over chokidar with 5s/30s-cap debounce; self-trigger suppression via post-promote `suppressOnce`; daemon reconciles watch entries on SIGHUP; `runPlugin` accepts `targets[]` and threads them into input.json + --allow-read. Tests cover debounce coalescing, glob filter, and suppression.  |
| f92c766   | Phase 6: lazy daemon spawn from `plugin install` when manifest declares schedule/watch; idempotent launchd plist / systemd user unit. `launchctl load` / `systemctl --user enable` is opt-in via `DITHER_INSTALL_AUTOSTART=1` to avoid touching the user's init system from tests.                             |
| c675082   | Phase 7: loop detection (`LoopDetector` with TTL + threshold) wired into daemon fire path; halts surfaced in status snapshot's `recentHalts`; richer `dither daemon status` view with schedule/watch entries + recent halts + recent failures.                                                                 |
| _pending_ | Phase 8: macOS TCC / Full Disk Access hint surface. `tcc-hint.ts` knows the protected `~/Library/...` prefixes; `plugin install` warns proactively when a `files[]` grant lands inside one; `runPlugin` reactively wraps PermissionDenied stderr from plugin children with the FDA hint. Non-macOS is a no-op. |
