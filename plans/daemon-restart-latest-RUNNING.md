# Plan: Daemon version-staleness self-restart

> Source spec: `specs/daemon-restart-latest.md`
> Depends on `plans/durable-fire-sources.md` for lossless restart.

## Architectural decisions

- **Build stamp:** `{version, sha, builtAt}`, SemVer-compatible
  (`0.0.1+<sha>.<builtAt>` in dev, bare `0.0.1` in prod). Baked via tsdown
  `define` (`__BUILD_STAMP__`); mirrored in `dist/build-info.json` written last
  via atomic rename. Single-sourced version.
- **Detection:** lazy, external IPC only (SIGUSR1, SIGHUP). Trigger = exact
  stamp difference. No timers.
- **Restart:** quiet (stop sources) → drain (plugin children up to
  `RESTART_DRAIN_MS` ≈ 300s; reconcile child SIGTERM'd) → hand-off (re-exec
  `execPath argv1 daemon run`, confirm via `waitForDaemonPid`, token PID
  ownership) → exit. Successor replays the WAL.
- **Failure:** rollback to old code if successor fails; flap counter (≥3 →
  disable); `handingOff` re-entrancy flag.

---

## Phase 1: Build stamp infrastructure

**User stories**: the daemon can name its own build and read the on-disk build.

Bake `__BUILD_STAMP__` via tsdown `define` (prebuild computes git short-sha +
`builtAt`); post-build writes `dist/build-info.json` atomically, last.
Single-source the version (drop the `main.ts`/`package.json` duplication).
Surface the stamp in `dither daemon status`.

**Acceptance:**
- [x] Build bakes a SemVer stamp into the bundle and writes a matching
      `dist/build-info.json` (atomic, written last).
- [x] Dev stamp carries `+sha.builtAt`; a clean prod-style build is bare semver.
- [x] Version single-sourced.
- [x] `dither daemon status` shows the running stamp.

---

## Phase 2: Staleness detection (detect + log, no restart yet)

**User stories**: "when an updated build is on disk … I notice."

Compare baked `__BUILD_STAMP__` vs `dist/build-info.json`; expose `isStale()`.
Hook it lazily at the top of the SIGUSR1 and SIGHUP handlers — log a
`stale-detected` event, but do **not** restart yet (proves detection in
isolation).

**Acceptance:**
- [x] `isStale()` true iff baked stamp ≠ sidecar stamp (handles missing sidecar).
- [x] Checked on SIGUSR1 + SIGHUP only; no timers.
- [x] Rebuild → next kick/HUP logs `stale-detected`; matching build → silent.

---

## Phase 3: The hand-off (quiet → drain → spawn → confirm → exit)

**User stories**: "I hand off to a fresh daemon and the action runs under new
code"; "my `plugin run` during a restart still completes."

On stale-detect, run the hand-off: stop sources, drain plugin children up to
`RESTART_DRAIN_MS` (SIGTERM the reconcile child immediately), spawn the successor
(fresh code), confirm via `waitForDaemonPid`, exit (token guard leaves the PID
file to the successor). Successor boot replays the queue and does the work.

**Acceptance:**
- [x] Stale + SIGUSR1 → successor spawned from the fresh bundle, old exits.
- [x] The triggering kick is handled by the **successor** (durable hand-off).
- [x] `RESTART_DRAIN_MS` is a separate, longer knob than `SHUTDOWN_GRACE_MS`.
- [x] Token PID ownership: old daemon does not clobber the successor's PID file.

---

## Phase 4: Failure handling (rollback, flap guard, re-entrancy)

**User stories**: "if the new build fails to boot, I stay on old code."

Guard the hand-off: if the successor doesn't write its PID within timeout, roll
back (re-enable sources, resume on old code). Add a flap counter (≥3 failures →
disable auto-restart, surface in status) and a `handingOff` flag to ignore
re-entrant triggers.

**Acceptance:**
- [x] Successor fails to come up → old daemon resumes on old code (not dead).
- [x] 3 consecutive failed restarts → auto-restart disabled + surfaced in status.
- [x] Re-entrant staleness triggers during a hand-off are ignored.

---

## Phase log

When starting implementation, rename to `plans/daemon-restart-latest-RUNNING.md`.
One phase at a time, tick acceptance, commit that phase's changes, continue.
Append a row after each phase. Rename back when complete.

| commit | summary |
|--|--|
| (pending) | P4: failure handling. Boot's inline `reconcile()`+`recoverAll(sources)` factored into `armSources()` — the single "bring sources up" wiring boot and rollback both call (reconcile re-`set()`s scheduler/watcher entries their `stop()` cleared). `handOff`'s two SEAMs (no-entrypoint, confirm-timeout) now route to `rollback(reason)` instead of exiting: `appendGlobal(daemon-restart-rolledback)` → `restartFails += 1` → at `FLAP_THRESHOLD=3` latch `restartDisabled` + log `daemon-restart-disabled` → clear `handingOff` → `armSources()` (restored kick drains on old code) → `writeStatus()`. Never `resolveExit`. `handOff` early-return now also gates on `state.restartDisabled` (once flapped, every trigger no-ops). Success path resets `restartFails=0`. Confirm loop reads a module-level `handoffConfirmMs` (default 30_000) with a test-only `setHandoffConfirmMs` setter so rollback/flap tests time out in ~150-300ms. Status snapshot + `dither daemon status` surface `restartDisabled`/`restartFails`. New event kinds `daemon-restart-rolledback`/`daemon-restart-disabled`. Tests: 3 new (rollback: fake successor never writes PID → confirm times out → `daemon-restart-rolledback` logged, run promise NOT resolved, PID file still our identity, `restartFails=1`/`restartDisabled=false`; flap: 3 SIGUSR1-driven rollbacks → `restartDisabled` true + status shows it + 4th trigger no-spawn/no-rollback; re-entrancy: gated `fireWithSuppress` mid-hand-off → no run). Typecheck clean; `daemon build-stamp` 47 pass, only the pre-existing no-`deno` `~3s` fire fails. |
| (pending) | P3: the hand-off. `handOff()` in `daemon.ts` (closure in `runDaemon`): set `handingOff` synchronously (re-entrancy + stop-dispatch gate) → `daemon-restarting` event → quiet (`scheduler/watcher/refirer/kicks.stop()`) → drain (SIGTERM `reconcileChild` immediately, wait plugin children up to new `RESTART_DRAIN_MS=300_000`, separate from `SHUTDOWN_GRACE_MS=30_000`) → spawn successor via the injectable `spawn` (detached `execPath argv1 daemon run`, `DITHER_DAEMON=1`, `unref`; guards missing argv1) → confirm by polling the PID file for a DIFFERENT identity (`pid!==process.pid \|\| token!==state.token`) that's alive (bounded by `HANDOFF_CONFIRM_MS=30_000`; NOT `waitForDaemonPid`, which returns our own pid) → exit via token-guarded `removePidFile` + `resolveExit` (leaves successor's PID file intact). **Choke-point gate:** `fireWithSuppress` returns `false` (no run) when `handingOff`; `fireKick` maps that to `"retry"` → Queue `restore` → kick stays pending for the successor's boot recover (kick-not-consumed invariant). Wired into both P3 SEAMs (`onHup`/`onUsr1`): `checkStale()` true → `void handOff()`, else normal reload/drain. New event kinds `daemon-restarting`/`daemon-restarted`/`daemon-restart-failed`. P4 rollback seam marked at confirm-timeout + missing-argv1 (logs `daemon-restart-failed`, falls through to graceful exit). Tests: 4 new (RESTART_DRAIN_MS≠SHUTDOWN_GRACE_MS, handingOff gates `fireWithSuppress`, kick-not-consumed retry→restore, full stale+SIGUSR1 drive with fake successor → restarting→restarted→exit + token guard). Typecheck clean; daemon/build-stamp/kicks 56 pass, only pre-existing no-`deno` `~3s` failure. |
| (pending) | P2: staleness detection (detect + log, no restart). `isStale()` in `build-stamp.ts` — full-stamp compare (version/sha/builtAt) vs `dist/build-info.json`; `disk === null` (missing sidecar / un-bundled) → not stale, test-safe. `checkStale()` in `daemon.ts` funnels both external IPC entries: top of `onHup` (SIGHUP) + a daemon-level SIGUSR1 listener alongside the kick Source's own drain — on stale, `appendGlobal({ kind: "stale-detected", from, to })` once, no restart. P3 seam comments mark where the hand-off branches in. New `stale-detected` event kind. Tests: 5 new (3 `isStale`, 2 `checkStale`) pass, typecheck clean, zero new daemon failures (only pre-existing no-`deno` `~3s` fire). |
| (pending) | P1: build-stamp infra — tsdown `define` bakes `__BUILD_STAMP__` (stamp computed once: pkg version + git short-sha + digits `builtAt`); `build:done` hook writes `dist/build-info.json` last via tmp+rename. `build-stamp.ts` accessor with test-safe fallback + `readBuildInfo`. Version single-sourced (`main.ts` + status snapshot via `buildVersion`/`stampString`). Stamp shown as `build:` in `daemon status`. Tests: 7 new pass, typecheck clean, zero new daemon failures. |
