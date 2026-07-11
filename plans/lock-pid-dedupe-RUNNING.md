# Plan: dedupe lock-file and PID-file reading

> Source spec: `specs/lock-pid-dedupe-DRAFT.md`

## Architectural decisions

- `holders()` lives in locks.ts, returns `LockHolder[]` (`{name, pid}`), live PIDs only (deliberate behavior change: drain loops stop as soon as a crashed child's lock goes stale).
- Shared strict `parsePidFile` moves to home.ts (pure leaf, owns `pidFilePath`, no import cycle). `DaemonPidFile` type moves with it.
- No new files.

---

## Phase 1: locks.holders()

Lock enumeration moves into locks.ts; daemon.ts deletes its copy.

**Acceptance:**
- [ ] `holders()` in locks.ts returns `{name, pid}` for live plugin locks only; `qmd-*`/`daemon-start` excluded
- [ ] `readRunningPlugins` + `RunningPlugin` deleted from daemon.ts; 3 call sites use `holders()`
- [ ] unused `readdir`/`join`/`locksDirPath`/`isPluginLock` imports removed from daemon.ts
- [ ] enumeration test moves to locks.test.ts (or daemon.test.ts imports holders); adds a dead-PID case

## Phase 2: one parsePidFile

**Acceptance:**
- [ ] strict `parsePidFile` + `DaemonPidFile` in home.ts; daemon-control.ts imports it
- [ ] `readPidIdentity` and inline parse in `removePidFile` deleted; both use shared parser
- [ ] `probeDaemon` typed reasons unchanged (tests green)
- [ ] `removePidFile` still unlinks only on matching pid + token

---

## Phase log

|  |  |
|--|--|
|  |  |
