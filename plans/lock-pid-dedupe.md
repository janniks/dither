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
- [x] `holders()` in locks.ts returns `{name, pid}` for live plugin locks only; `qmd-*`/`daemon-start` excluded
- [x] `readRunningPlugins` + `RunningPlugin` deleted from daemon.ts; 3 call sites use `holders()`
- [x] unused `readdir`/`join`/`locksDirPath`/`isPluginLock` imports removed from daemon.ts
- [x] enumeration test updated with a dead-PID case, imports holders from locks

## Phase 2: one parsePidFile

**Acceptance:**
- [x] strict `parsePidFile` + `DaemonPidFile` in home.ts; daemon-control.ts imports it
- [x] `readPidIdentity` inline parse and `removePidFile` inline parse replaced with shared parser
- [x] `probeDaemon` typed reasons unchanged (tests green)
- [x] `removePidFile` still unlinks only on matching pid + token

---

## Phase log

|  |  |
|--|--|
| 09ad53c | Phase 1: locks.holders(), daemon parser deleted, dead-PID test |
| 2195c33 | Phase 2: shared parsePidFile in home.ts |
