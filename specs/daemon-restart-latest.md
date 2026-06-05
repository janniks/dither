# Spec: Daemon version-staleness self-restart

> Depends on [[durable-fire-sources]]: restart = stateless **kill-and-replay**
> over the durable queue (Temporal's model — [[queue-patterns-survey]]).

## Problem

The daemon is long-lived; its on-disk bundle (`dist/cli.mjs`) gets rebuilt or
upgraded underneath it, leaving a **stale supervisor** running old scheduling,
watch, and supervision logic. Heavy work already re-execs fresh (the reconcile
child, P1–P6), but the supervisor itself doesn't. Goal: **never run an outdated
daemon** — detect staleness and cleanly hand off to the latest build, losing or
double-processing nothing.

## Stories

- As the daemon, when an updated build is on disk and a user action arrives, I
  hand off to a fresh daemon and the action runs under the new code.
- As a user, my `plugin run` during a restart still completes — the kick is
  durable; the successor drains it.
- As the daemon, if the new build fails to boot, I stay on old code rather than
  dying.

## Decisions

### Staleness signal — a SemVer build stamp

- Stamp = `{version, sha, builtAt}`. **SemVer-compatible**: core
  `MAJOR.MINOR.PATCH`; dev appends build metadata `+<sha>.<builtAt>` (ignored by
  SemVer *precedence*, §10). Prod = bare semver (no git → no sha).
- `builtAt` (digits, no colons) makes **every rebuild** a distinct stamp
  (per-rebuild granularity — catches uncommitted dev rebuilds).
- Baked into the bundle via tsdown `define` (`__BUILD_STAMP__`). Mirrored in a
  sidecar **`dist/build-info.json`**, written **last** via atomic rename — its
  presence with a new stamp also signals "build complete" (guards against
  spawning a half-written bundle).
- Trigger = **exact stamp difference** (baked ≠ sidecar). Disk is authoritative
  (different → restart, downgrade included).
- **Single-source the version** (today duplicated in `main.ts` + `package.json`).

### Detection cadence — lazy, external IPC only

- Check at the top of **SIGUSR1** (before `scanKicks`) and **SIGHUP** (before
  reload/reconcile). **No timers.**
- Internal scheduler/watcher/refirer fires do **not** check (deferred —
  [[daemon-restart-followups]]). Relies on every IPC being durable-on-disk
  (kicks) or stateless (SIGHUP); an IPC with an ephemeral in-memory payload would
  need explicit re-delivery.

### Restart — quiet → drain → hand-off

- **quiet**: stop sources (scheduler/watcher/refirer + skip `scanKicks`).
  Producers keep enqueuing durably; only dispatch pauses (well-defined at every
  entry point *because* the queue is durable — [[durable-fire-sources]]).
- **drain**: let in-flight **plugin children** finish within `RESTART_DRAIN_MS`
  (~300s — its own knob, **separate** from the interactive `SHUTDOWN_GRACE_MS`
  ≈ 30s). The **reconcile child** is SIGTERM'd immediately (durable in SQLite,
  re-reconciled via marker). Stragglers past the grace are rolled back + re-fired.
- **hand-off**: spawn the successor by re-exec'ing `process.execPath` +
  `process.argv[1] daemon run` (fresh code from disk; detached + `unref`),
  bypassing `startDaemon`'s already-running guard. Confirm it via
  `waitForDaemonPid`. **Token-based PID ownership**: the successor writes its own
  `{pid, token}`; the old daemon's shutdown won't unlink a PID file whose token
  no longer matches (existing guard). Old exits.
- successor boot **replays the WAL** (every Source's `recover`) → does the queued
  work. This is the whole "do the thing we wanted" — no explicit hand-off of the
  request; the durable queue *is* the hand-off.

### Failure handling

- Successor doesn't write its PID within timeout → **roll back**: re-enable
  sources, resume on old code (better stale than dead).
- **Flap counter**: ≥3 failed restarts → disable auto-restart, surface in status.
- **`handingOff` flag**: ignore re-entrant staleness triggers mid-restart.

## Non-goals / deferred

In-place `execve`/native re-exec (rejected — needs a native dep). Internal-fire
staleness checks and lazy sweep — [[daemon-restart-followups]].
