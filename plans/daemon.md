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
- [ ] Lock primitive: atomic acquire via `O_EXCL`; PID written into lock file; release on drop; stale-PID recovery on next acquire.
- [ ] `dither plugin run X` acquires the lock before spawn and releases in `finally` (including on signal).
- [ ] Concurrent `dither plugin run X` invocations: exactly one runs; the other exits non-zero with a clear "already running" message; no partial entries in `entries/`.
- [ ] Tests: two-process race; release-after-process-death recovery; release in `finally` on plugin failure.
- [ ] All gates green.

---

## Phase 2: Run-history journal + `dither runs list` / `dither runs tail`

**User stories:** 9, 11, 12.

End-to-end behavior: every plugin run — manual today, scheduled and watch in later phases — produces a durable record at the run-history path. The record captures plugin name, trigger kind, started-at, finished-at, exit code, captured stderr tail, and a stream of progress / stdout / stderr / promoted events. New CLI subcommand `dither runs list` enumerates recent runs with their outcomes; `dither runs tail <runId>` streams a live run's events as they're appended.

**Acceptance:**
- [ ] Run-history dir created on every plugin run start; `manifest.json` written immediately, `events.ndjson` appended as the plugin emits, `result.json` written on completion.
- [ ] Failed runs preserve the journal (stderr tail, exit code, error event).
- [ ] `dither runs list` lists the most recent N runs with name, started-at, status, duration.
- [ ] `dither runs tail <runId>` streams the live `events.ndjson` (chokidar tail of the file); exits when the run completes or the user hits Ctrl-C.
- [ ] Tests: round-trip read of a completed run; tail against an actively-appended file; failed-run record preserved.
- [ ] All gates green.

---

## Phase 3: Daemon entrypoint, signal handling, status snapshot

**User stories:** 10, 13, 14.

End-to-end behavior: `dither daemon start` spawns the long-lived daemon process detached, writing the PID file and the daemon log. The daemon enters its main loop (currently a no-op heartbeat — schedulers and watchers come in later phases) and writes a status snapshot periodically. `dither daemon stop` sends SIGTERM and the daemon exits cleanly. `dither daemon status` reports up/down (reading PID + status snapshot). `dither daemon logs` follows the daemon log.

The empty inner loop is the point: phase 3 ships the lifecycle and the cross-process surfaces; phases 4 and 5 fill the loop.

**Acceptance:**
- [ ] Daemon entrypoint runs detached with PID file at the known path; daemon log at the known path.
- [ ] SIGTERM handler: stops accepting new triggers, waits up to 30 s for in-flight plugin children (none in this phase), exits.
- [ ] SIGHUP handler is registered (no-op in this phase; reload semantics arrive in phase 4).
- [ ] Status snapshot file written periodically and on event (event surface trivial in this phase: just up/down).
- [ ] CLI subcommands `dither daemon start | stop | status | logs` work end-to-end.
- [ ] `dither status` reads the snapshot and the lock dir; `--json` flag emits structured output.
- [ ] Tests: daemon start → snapshot present; SIGTERM during quiet daemon → clean exit within timeout; status reads the snapshot correctly.
- [ ] All gates green.

---

## Phase 4: Scheduler — schedules fire

**User stories:** 1, 5, 6, 16.

End-to-end behavior: the daemon, on startup, reads every plugin's grants file, parses each plugin's `schedule` field (via croner + the in-house shorthand), and registers the resulting schedules. When a tick lands, the daemon fires the plugin via the same `runPlugin` code path the CLI uses, writing to the run-history journal. SIGHUP triggers re-read of grants and reconcile of the schedule set in-place. `plugin install` and `plugin remove` send SIGHUP to the running daemon (best-effort; no-op if not running). The plugin's `input.json.trigger` is `"scheduled"` for these fires.

**Acceptance:**
- [ ] Scheduler module wraps croner; `set(entries)` replaces, `stop()` cancels; reload doesn't miss or duplicate fires across replacement.
- [ ] Daemon registers schedules from grants on startup.
- [ ] Schedule fires call into `runPlugin` with `trigger: "scheduled"`; lock acquire, run-history journal, all integrate correctly.
- [ ] SIGHUP triggers grants re-read and scheduler reconcile in-place; running plugins are unaffected.
- [ ] CLI `plugin install` / `plugin remove` send SIGHUP after grants changes (no-op when daemon isn't running).
- [ ] End-to-end test: install a fixture plugin with `schedule: "every 1s"`, start the daemon, wait 3 s, stop with SIGTERM; assert two scheduled fires landed in run-history with success exit codes; clean shutdown within timeout.
- [ ] All gates green.

---

## Phase 5: Watcher — file changes fire plugins

**User stories:** 2, 16.

End-to-end behavior: the daemon also reads each plugin's `watch` field and registers chokidar watchers against the configured collections + glob (defaulting to `**/*.md`). File changes within the watched paths fire the plugin after the debounce window (5 s default, 30 s cap), with the changed paths in `input.json.targets`. The plugin's `input.json.trigger` is `"watch"`. Watch + schedule on the same plugin coexist via the lock — one wins per concurrent fire.

**Acceptance:**
- [ ] Watcher module wraps chokidar; `set(entries)` replaces, `stop()` cancels; debounce coalesces N events into 1 fire (5 s window, 30 s cap).
- [ ] Self-trigger suppression: when the daemon promotes a file, a recently-promoted-paths map (TTL ~2 s) drops chokidar events for those paths to avoid feedback loops.
- [ ] Watch fires call `runPlugin` with `trigger: "watch"` and `targets: [...changedPaths]`.
- [ ] Watch + schedule on the same plugin: independent attempts at the lock; whichever runs first owns the run.
- [ ] Reload (SIGHUP) reconciles watcher set without dropping in-flight events.
- [ ] Test: drop a `.md` file into a watched collection, assert the plugin fires within debounce window with the new path in `targets`.
- [ ] Test: watch + schedule both fire near-simultaneously; assert exactly one runs and the other is dropped (logged).
- [ ] All gates green.

---

## Phase 6: Lazy daemon spawn + OS persistence

**User stories:** 3, 4.

End-to-end behavior: when the user runs `dither plugin install <plugin>` and the plugin's manifest declares `schedule` or `watch`, the install command spawns the daemon detached and registers a launchd plist (macOS) / systemd user unit (linux) so the daemon comes back across reboots. Users installing only manual plugins never see a daemon. The PID-check + self-respawn pattern (already locked architecture) is the primary recovery layer; OS persistence is the secondary.

This phase splits cleanly into two halves if needed: (6a) lazy spawn alone, (6b) launchd/systemd registration. Ship as one if both go smoothly; split if 6b runs into platform churn.

**Acceptance:**
- [ ] Lazy spawn: `dither plugin install` of a scheduled/watch plugin starts the daemon detached if no PID file is alive.
- [ ] launchd plist generation on macOS: written into `~/Library/LaunchAgents/`, references the dither binary's absolute path, registers via `launchctl load`.
- [ ] systemd user unit on linux: written into `~/.config/systemd/user/`, registers via `systemctl --user enable`.
- [ ] Re-install of an already-scheduled plugin does not duplicate the daemon (PID check + idempotent registration).
- [ ] Users with no scheduled/watch plugins never get a daemon spawned and never get launchd/systemd registration.
- [ ] Test (macOS): install a scheduled plugin → PID file exists → process is alive.
- [ ] Test (linux): same.
- [ ] All gates green.

---

## Phase 7: Loop detection + richer status surface

**User stories:** 7, 14.

End-to-end behavior: the daemon tracks trigger chains (a fire that itself causes another fire that causes another) via a depth tracker with TTL. When depth reaches the configured threshold (default 3), the chain is halted and the halt is surfaced in `dither status`. The status surface gains the compact daemon block: registered schedules with next fires, currently running plugins, recent failures. `dither status --json` emits the structured equivalent for tooling.

**Acceptance:**
- [ ] Loop detector: pure module; `record(triggerSource, pluginName)` and `shouldHalt()`; chain entries roll off after configurable TTL.
- [ ] When `shouldHalt()` returns true, daemon refuses to fire the plugin and writes a halt event to status snapshot + daemon log.
- [ ] `dither status` shows: daemon up/down + uptime + PID; plugin counts (scheduled, watched, running); next 3 fires with relative times; last 3 failures; any active halts.
- [ ] `dither status --json` emits the same data structured.
- [ ] Test (loop detector): record three nested triggers → fourth halts; record then wait > TTL → counter resets.
- [ ] Test (status): manually populate a snapshot with running, failed, halted entries; assert the human and JSON formats render correctly.
- [ ] All gates green.

---

## Phase 8: macOS Full Disk Access / TCC hint surface

**User stories:** 15.

End-to-end behavior: when a plugin's `files[]` grant resolves to a path under a known macOS TCC-protected prefix (`~/Library/Messages`, `~/Library/Photos`, `~/Library/Mail`, `~/Library/Calendars`, `~/Library/Reminders`, etc.), `dither plugin install` prints an FDA hint up front. At runtime, when a plugin read returns `EPERM` and the path matches one of those prefixes, the host wraps the error with the same hint pointing to System Settings.

Linux and Windows are no-ops in this phase — TCC has no equivalent layer; Unix permissions / NTFS ACLs are the only gate.

**Acceptance:**
- [ ] On macOS install: scanning `files[]` grants for known TCC-protected prefixes; print hint listing the binary path the user should add to FDA in System Settings.
- [ ] On macOS runtime: `EPERM` on a read against a TCC-protected prefix is wrapped with the same hint and the resolved binary path; non-macOS skips the wrapping.
- [ ] Test: macOS-only test asserts the install-time hint fires for a fixture with a `files[]` grant under `~/Library/Messages`; non-macOS skips.
- [ ] Test: macOS-only test asserts the runtime wrap fires by mocking an EPERM response on a protected path; non-macOS skips.
- [ ] All gates green.

---

## Phase log

When starting implementation, rename this file to `./plans/daemon-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. Stage and commit only that phase's changes after finishing, then continue to the next phase. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/daemon.md`.

| commit | summary |
|---|---|
|  |  |
