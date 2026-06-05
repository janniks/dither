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
- [ ] `isStale()` true iff baked stamp ≠ sidecar stamp (handles missing sidecar).
- [ ] Checked on SIGUSR1 + SIGHUP only; no timers.
- [ ] Rebuild → next kick/HUP logs `stale-detected`; matching build → silent.

---

## Phase 3: The hand-off (quiet → drain → spawn → confirm → exit)

**User stories**: "I hand off to a fresh daemon and the action runs under new
code"; "my `plugin run` during a restart still completes."

On stale-detect, run the hand-off: stop sources, drain plugin children up to
`RESTART_DRAIN_MS` (SIGTERM the reconcile child immediately), spawn the successor
(fresh code), confirm via `waitForDaemonPid`, exit (token guard leaves the PID
file to the successor). Successor boot replays the queue and does the work.

**Acceptance:**
- [ ] Stale + SIGUSR1 → successor spawned from the fresh bundle, old exits.
- [ ] The triggering kick is handled by the **successor** (durable hand-off).
- [ ] `RESTART_DRAIN_MS` is a separate, longer knob than `SHUTDOWN_GRACE_MS`.
- [ ] Token PID ownership: old daemon does not clobber the successor's PID file.

---

## Phase 4: Failure handling (rollback, flap guard, re-entrancy)

**User stories**: "if the new build fails to boot, I stay on old code."

Guard the hand-off: if the successor doesn't write its PID within timeout, roll
back (re-enable sources, resume on old code). Add a flap counter (≥3 failures →
disable auto-restart, surface in status) and a `handingOff` flag to ignore
re-entrant triggers.

**Acceptance:**
- [ ] Successor fails to come up → old daemon resumes on old code (not dead).
- [ ] 3 consecutive failed restarts → auto-restart disabled + surfaced in status.
- [ ] Re-entrant staleness triggers during a hand-off are ignored.

---

## Phase log

When starting implementation, rename to `plans/daemon-restart-latest-RUNNING.md`.
One phase at a time, tick acceptance, commit that phase's changes, continue.
Append a row after each phase. Rename back when complete.

| commit | summary |
|--|--|
| (pending) | P1: build-stamp infra — tsdown `define` bakes `__BUILD_STAMP__` (stamp computed once: pkg version + git short-sha + digits `builtAt`); `build:done` hook writes `dist/build-info.json` last via tmp+rename. `build-stamp.ts` accessor with test-safe fallback + `readBuildInfo`. Version single-sourced (`main.ts` + status snapshot via `buildVersion`/`stampString`). Stamp shown as `build:` in `daemon status`. Tests: 7 new pass, typecheck clean, zero new daemon failures. |
