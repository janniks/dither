# Daemon, schedule, and watch (Phase 4)

## Problem Statement

Today, plugin manifests can declare `schedule` (a cron-ish string) and `watch` (`{ collections, glob }`), but those fields are inert — no process is responsible for firing on them. The only way to run a plugin is `dither plugin run <name>` from a shell. There is no:

- Process that ticks schedules and fires plugins on time.
- File watcher that reacts to changes in `~/.dither/entries/<collection>/`.
- Owner of the qmd handle across plugin runs (each run re-opens it).
- Coordination for "is this plugin already running?" — two CLI invocations can race for the same plugin.
- Cross-process visibility: `dither status` can show static counts but not "what's running right now," "when does X next fire," or "what failed recently."

The user wants those declarations to mean something: a plugin marked `every 15m` should fire every fifteen minutes, even when the user has no terminal open. A plugin watching a collection should react when files in that collection change. And the user should be able to see what the system is doing without grepping logs.

## Solution

A long-lived `dither daemon` process — the same binary as the CLI, run in long-lived mode — owns the scheduler, watchers, the qmd handle, plugin spawn lifecycle, and the run-history journal. The daemon writes its state to the filesystem (run dirs, lock files, status snapshot, log); the CLI reads that filesystem to answer status queries. The CLI and daemon do not share an in-process IPC channel: filesystem coordination + Unix signals do everything they need to.

The daemon spawns lazily — only when the user installs the first plugin that declares `schedule` or `watch`. Once spawned, launchd / systemd carry it across reboots; if those break, the locked self-respawn pattern (every CLI invocation checks the PID file) brings it back.

When the daemon is running, it ticks scheduled plugins and reacts to file changes in watched paths. When a manual `dither plugin run X` invocation runs alongside it, the two coordinate via a per-plugin lock file: whoever acquires the lock first runs; the other returns "already running" and exits cleanly. Both write to the same run-history dirs, so `dither status` and `dither runs list` see a consistent picture regardless of which path fired the run.

## User Stories

1. As a user with a Gmail-ingest plugin declaring `schedule: "every 15m"`, I want the plugin to fire every fifteen minutes without me opening a terminal, so my index stays current automatically.
2. As a user with a folder-importer plugin declaring `watch: { collections: ["inbox"] }`, I want the plugin to fire when I drop a new markdown file into that collection, so transformations happen the moment the source changes.
3. As a user who only runs manual plugins, I don't want a daemon process running in the background, so my system stays quiet when nothing needs scheduling.
4. As a user with a scheduled plugin installed once, I want the schedule to keep firing across reboots, so I don't have to remember to start anything by hand.
5. As a user installing a plugin with a schedule, I want the new schedule to fire on its next tick without restarting the daemon manually, so install feels live.
6. As a user removing a plugin, I want its schedule and watcher to stop immediately, so it can't fire after I've decided to remove it.
7. As a user, I want `dither status` to show me which plugins are currently running, when each scheduled plugin fires next, and which plugins have failed recently, so I can answer "what's the system doing?" in one command.
8. As a user running `dither plugin run X` while a scheduled fire of X is already in progress, I want a clear "already running, please wait" message and a non-zero exit, so I know my click wasn't lost.
9. As a user whose plugin's Deno subprocess crashed mid-run, I want the failure recorded with its exit code and a tail of stderr, so I can debug without re-running.
10. As a user, I want the daemon's logs at a known path (`~/.dither/logs/daemon.log`) so I can `tail -f` or grep without configuration.
11. As a user, I want `dither runs tail <runId>` to follow a live run's events stream so I can watch a long backfill without a special viewer.
12. As a user, I want `dither runs list` to show recent runs with their outcome, so I can audit what fired when.
13. As a user, I want to stop the daemon gracefully with `dither daemon stop`, with in-flight plugins given time to finish before being killed, so I don't corrupt mid-write state.
14. As a tooling author, I want `dither status --json` to emit machine-readable output so I can pipe it into a status bar or dashboard.
15. As a macOS user with a plugin that needs to read a TCC-protected path (Messages, Photos), I want a clear "grant Full Disk Access to dither in System Settings" message instead of a cryptic permission error.
16. As a plugin author, I want the daemon's spawn model to be transparent so my plugin code doesn't have to know whether it's running from a manual invocation or a scheduled tick. The same `runPlugin` code path runs in both cases; `input.json.trigger` distinguishes them when needed.

## Implementation Decisions

### Lifecycle

- **Lazy spawn on schedule/watch presence.** First time a plugin with a `schedule` or `watch` field is installed, the CLI spawns the daemon detached and registers a launchd plist (macOS) / systemd user unit (linux) for persistence. Users who never install a scheduled plugin never run a daemon.
- **Self-respawn carries it.** Every CLI invocation reads `~/.dither/dither.pid` and checks if the PID is alive; if not, it spawns the daemon. launchd/systemd is the secondary layer; the PID-check is the primary.

### CLI ↔ daemon coordination — filesystem + signals, not a socket

- **Single source of truth = the filesystem.** Lock files, run dirs, status snapshot, daemon log. Both daemon and CLI read/write the same files atomically.
- **No unix socket, no NDJSON protocol, no dispatcher.** Considered, sketched, rejected. Adds ~150 LOC of novel surface for what filesystem primitives + signals already do in ~30 LOC. Kept as "alternative considered" for revisit if MCP or remote management ever needs it; MCP has its own protocol regardless.
- **Daemon control = Unix signals.**
  - `kill -TERM <pid>` (`dither daemon stop`) — graceful: wait up to 30 s for in-flight plugins, then SIGTERM children, then SIGKILL after a 5 s grace.
  - `kill -HUP <pid>` (`dither daemon reload`) — re-scan grants, reconcile schedule/watcher set in-place.
  - `kill -INT <pid>` (Ctrl-C on the foreground daemon) — same as SIGTERM.
- **Schedule reload on grants change.** `dither plugin install` and `dither plugin remove` write/remove the grants file, then `kill -HUP <daemon-pid>` (best-effort; no-op if daemon isn't running). No filesystem-watcher on the grants directory itself.

### Lock-based concurrency

- **`~/.dither/locks/<plugin-name>.lock` is the single arbiter.** Created atomically with `O_EXCL`; the file holds the PID of whoever's running.
- **Skip-if-running, universal.** Every trigger — schedule, watch, manual — tries to acquire the lock. Failure is the universal "already running" outcome: log it, surface in status, exit. No queue, no kill, no parallel.
- **Stale-lock recovery.** If a lock exists but its PID is dead, the next acquirer overwrites and proceeds. Safe because the previous holder can't be writing anymore.
- **Watch + schedule on the same plugin behave independently.** Each layer is its own attempt at the lock; whichever fires first runs, the other is dropped (logged). Watch-event coalescing happens within chokidar's debounce window (5 s default, 30 s cap, both decided earlier); it does not couple to the scheduler.

### Process supervision

- **No automatic retry.** Plugin exits non-zero → daemon records exit code + tail of stderr in the run dir, surfaces in status, moves on. Schedule re-fires are the natural retry mechanism.
- **No crash-loop disable.** The user is the loop closer: they look at status, see repeated failures, remove or fix the plugin.

### Run history

- **`~/.dither/runs/<runId>/` is the journal directory.** Each run gets:
  - `manifest.json` — plugin name, trigger kind, started-at, finished-at, exit code, summary (counts: promoted entries, etc.).
  - `events.ndjson` — append-only stream of `{ ts, kind, ... }` lines: `progress`, `stdout`, `stderr`, `promoted`, `error`. Written as the run executes.
  - `result.json` — final terminal record on success.
- **Run dir is preserved on completion.** Older runs are pruned by a future tool; v1 keeps them all (filesystem grows; user can clean).
- **Failed runs preserve the run dir** so the user can inspect `events.ndjson`. The recently-introduced run-dir cleanup-on-success in `runPlugin` shifts: success cleans the *scratch* `runs/<id>/` (where the plugin wrote outputs being promoted); the *journal* `runs/<id>/` here is a different role, distinct from the scratch dir. Naming may need to disambiguate; current proposal: scratch lives under `runs/<id>/`, journal under `history/<id>/` (or invert), to avoid mixing concerns.

### Status

- **`~/.dither/status.json`** — daemon writes a snapshot periodically (e.g. every 5 s while idle, on event when something changes). Reader-side, the CLI loads this for the human view.
- **`dither status` shows a compact daemon block** in addition to the existing summary: daemon up/down + uptime + PID, plugin counts (with sub-counts for scheduled/watch/running), next-3 fires with relative times, last-3 failures.
- **`dither status --json` emits the same data structured** for tooling.

### Logging

- **`~/.dither/logs/daemon.log`** — single rolling append file for the daemon's own stdout + stderr (scheduler decisions, reload events, errors, lock contentions, loop-detection halts).
- **No rotation in v1.** User can `> daemon.log` to truncate; future tiny size-cap rotator if needed.

### Loop detection

- **In-memory trigger-chain depth tracker.** A `record(triggerSource, pluginName)` call links a fire to its trigger; if a chain reaches depth 3, halt and surface in status.
- **TTL on the chain map** (configurable, default ~10 s) so unrelated trigger chains don't accumulate.

### OS-level permission interactions (macOS Full Disk Access / TCC)

- **TCC is orthogonal to dither's grant model.** Deno's `--allow-read` is necessary but not sufficient for macOS-protected paths (`~/Library/Messages`, `~/Library/Photos`, etc.). The kernel checks TCC against the responsible application; the user must grant Full Disk Access to the dither binary once.
- **Inheritance helps:** because the daemon is the long-lived parent of every plugin spawn, the FDA grant on dither propagates to every plugin run uniformly. The user grants once.
- **The host detects TCC failures and surfaces a useful error.** When a plugin read returns `EPERM` on a path matching a known TCC-protected prefix, the daemon wraps the error: "Plugin tried to read `<path>` but macOS Full Disk Access is not granted to dither. Open System Settings → Privacy & Security → Full Disk Access and add the dither binary at `<resolved-path>`."
- **Install-time hint.** When a plugin's `files[]` grant resolves to a TCC-protected prefix, the install command prints the same hint up front rather than waiting for a runtime failure.
- **Linux / Windows** have no equivalent TCC layer; Unix permissions / Windows ACLs are the only gate.

### Modules

| module | new/mod | role |
|---|---|---|
| `daemon.ts` | new | Long-lived entry point. Loads grants once, spins up scheduler + watcher, writes status snapshot, signal handlers, exits cleanly. |
| `scheduler.ts` | new | Wraps `croner` + the in-house shorthand parser. `set(entries)` replaces the active schedule; `stop()` cancels everything. |
| `watcher.ts` | new | Wraps `chokidar`. `set(entries)` replaces watcher set. Debounce + coalesce inside. |
| `locks.ts` | new | Atomic lock-file primitives via `O_EXCL`. `acquire(name) → handle \| null`, `release(handle)`. Stale-PID recovery. |
| `run-history.ts` | new | File-format owner for the run-history journal. Writes `manifest.json`, appends `events.ndjson`, finalises `result.json`. Reader helpers for `runs list` / `runs tail`. |
| `status-snapshot.ts` | new | Daemon-side: writes `~/.dither/status.json` periodically and on event. CLI-side: reader helpers. |
| `loop-detector.ts` | new | Pure: trigger-chain depth tracker with TTL. `record()` + `shouldHalt()`. |
| `plugin-run.ts` | mod | Acquire lock before spawn, release in `finally`. Append captured stderr/stdout to run-history `events.ndjson`. |
| `commands/daemon.ts` | new | `dither daemon start \| stop \| reload \| status \| logs`. PID file + signals. |
| `commands/runs.ts` | new | `dither runs list \| tail`. Reads run-history dirs. |
| `commands/plugin.ts` | mod | `install`/`remove` send SIGHUP to a live daemon. `run` integrates with locks. |
| `commands/status.ts` | mod | Reads `status.json`, walks `~/.dither/locks/`, formats human / `--json`. |
| `main.ts` | mod | Registers `daemon` and `runs` subcommands. |

### Deep modules (small interface, lots of behaviour hidden, rare to change once right)

- **`locks.ts`** — five-line interface, hides `O_EXCL` race semantics and PID-stale recovery.
- **`scheduler.ts`** — `set` + `stop`, hides croner reload subtleties.
- **`loop-detector.ts`** — `record` + `shouldHalt`, hides depth tracking and TTL.
- **`run-history.ts`** — file-format owner; nothing else reaches into the dirs directly.

## Testing Decisions

Good tests verify behaviour through the public interface, not implementation details. For this spec:

- **`locks.ts`** — definitely. Two concurrent `acquire` calls (one wins); stale-PID recovery; lock release on handle drop; release-after-process-death recovery on next acquire.
- **`loop-detector.ts`** — definitely. Pure unit tests: depth-3 halt, TTL roll-off, isolation between unrelated chains.
- **`scheduler.ts`** — yes, with synthetic clock. "Fires on schedule," "set replaces schedule set without missing or duplicating fires," "stop cancels everything."
- **`watcher.ts`** — integration test against a real temp dir with chokidar. Cover: debounce coalesces N events into 1 fire; multiple plugins watching the same root; watcher set replacement.
- **`run-history.ts`** — round-trip tests for `manifest.json` / `events.ndjson` / `result.json`; `tail`-style read against an actively-appended `events.ndjson` (a future-`runs tail` integration test).
- **Daemon end-to-end** — a single integration test exercising the whole loop: install a fixture plugin with `schedule: "every 1s"`, start the daemon, wait 3 s, stop with SIGTERM, assert two scheduled fires landed in run-history with success exit codes and the daemon shut down cleanly within timeout.
- **CLI / daemon coexistence** — fixture plugin, daemon running with a fast schedule, simultaneously launch `dither plugin run <plugin>`; assert exactly one of the two acquires the lock, the other prints "already running" and exits non-zero, no partial run-history.

Tests follow existing patterns (vitest, `mkdtempSync(tmpdir(), ...)` for `DITHER_HOME`, fixtures under `packages/cli/test/fixtures/`).

## Out of Scope

- **MCP server.** Deferred entirely to its own phase. Daemon will own it eventually (architecture says so), but phase 4 ships without any MCP listener or tool surface. No stub-bind.
- **Per-plugin retry / concurrency knobs.** Universal "skip if running" + "no automatic retry" is the v1 policy. A manifest-level `retry: ...` or `concurrency: "queue|parallel"` field can be added when a real plugin needs it; not now.
- **Daemon API for remote management.** No socket, no HTTP, no remote control. The daemon is local-only. If a future need to control a remote dither emerges, MCP is the door.
- **Lock-aware queueing.** When skip-if-running drops a fire, no queue holds it for later. The next natural fire (next schedule tick, next watch event, next manual click) is the retry.
- **Run-history pruning.** v1 keeps every run dir indefinitely. A pruning command is future work; users can `rm -rf` selectively today.
- **Daemon self-update.** Out of scope; `dither` is updated via npm / the binary distribution, the daemon respawns at next CLI invocation.
- **Multi-machine sync of schedules / runs.** Out of scope (sync is a separate v2 phase).
- **Live `dither watch` UI.** The TUI dashboard ("nice menu of running plugins") is a future polish; v1 has `dither status` (point-in-time) and `dither runs tail` (single-run stream).

## Further Notes

- The "scratch run dir" used by `runPlugin` (where the plugin writes its `*.md` outputs being promoted) and the "history run dir" used by this spec are conceptually different. Naming should disambiguate. Current proposal: keep `~/.dither/runs/<runId>/` for the scratch (unchanged), and add `~/.dither/history/<runId>/` for the journal. Final naming decided at implementation time.
- Status snapshot frequency (`~/.dither/status.json`) starts at 5 s while idle; on event (run start, run end, schedule fire, reload), an immediate snapshot is written. Tunable later.
- Loop-detection depth threshold is configurable (default 3) but not via manifest — it's a host knob, set via env or config file. Surfaces in `dither status` when a halt happens.
- The `tcc:` line in `dither status` (canary read against a known TCC-protected path on macOS) is optional polish; not blocking for v1.
- Bun-compiled single-file binary distribution (already a stretch goal in the architecture) becomes more valuable here: FDA grants bound to the binary path don't drift across `nvm` / `fnm` switches.

## Alternatives considered (not adopted)

- **Unix socket + NDJSON dispatcher.** Bespoke per-line JSON over `~/.dither/dither.sock` with request/response and event-stream patterns sharing a single envelope. v1 method set: `daemon.status`, `daemon.stop`, `daemon.reload`, `plugin.list`, `plugin.fire`, `runs.list`, `runs.tail`. ~150 LOC of dispatcher + protocol, plus a versioning concern over time. Rejected: filesystem coordination + signals do the same job with ~30 LOC of novel code; locks, PID files, run dirs, and signal handlers are pre-existing concerns. Revisit if MCP or remote management ever justifies the protocol surface.
- **HTTP on localhost.** Heavier than unix socket; needs port discovery; auth on loopback isn't private from other users. Strictly worse than the socket plan, which we already rejected.
- **FIFO pair.** Loses connection identity; back-pressure tricky; not actually simpler.
- **No daemon at all — `dither tick` from launchd.** launchd timer fires `dither tick` every N seconds; tick reads schedules and runs anything due. Loses chokidar (file watch becomes coarse-poll); reopens qmd handle every tick (heavy); 5 s / 30 s watch debounce awkward; loop detection across runs needs file-state anyway.
- **Routing manual `plugin run` through the daemon for "single source of truth."** The goal was right — consistent view of running state — but the chosen primitive (IPC) was wrong. Filesystem-as-truth (lock files + run dirs) gives the same property with no protocol.
