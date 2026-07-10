# Dedupe lock-file and PID-file reading

Source: architecture review 2026-07-10 + intent check. Aligns with the locked liveness model (pid file + `kill(pid,0)` + token match, nothing time-based).

## Problem

- `daemon.ts` `readRunningPlugins` (299–325, 27 lines) hand-rolls lock-file enumeration: `readdir(locksDirPath())`, filter `.lock`, strip suffix, `isPluginLock` filter, read each file, parse the PID. `locks.ts` already owns every piece of that. Called every 250ms in two drain loops (`daemon.ts:563`, `:607`) plus the status snapshot writer (`:343`).
- The PID file is parsed by three different bits of code with three strictness levels:
  - `daemon-control.ts` `parsePidFile` (44–57) — strict; feeds `probeDaemon`'s typed reasons.
  - `daemon.ts` `readPidIdentity` (281–297) — loose; used by hand-off confirm.
  - `daemon.ts` `removePidFile` (264–273) — inline `JSON.parse`, no structural check; shutdown self-check.

## Solution

- Lock enumeration → `locks.ts`. Add `holders(): Promise<LockHolder[]>` (`LockHolder = {name, pid}`), reusing its own dir/naming/`isPluginLock`/`isPidAlive`. Delete `readRunningPlugins` + `RunningPlugin` from `daemon.ts`; the three call sites call `holders()`; `StatusSnapshot.running` becomes `LockHolder[]`. New function next to `status`/`statusAll` (`statusAll` is a fixed 3-theme record — wrong shape for an open-ended plugin list).
- `holders()` returns only live holders (dead PIDs dropped). Deliberate behavior change: old code surfaced stale dead-PID locks, so drain loops waited the full grace window after a child crash; now they stop as soon as the lock goes stale — exactly the pid + `kill(pid,0)` liveness model.
- One PID parser → `home.ts`. Move the strict `parsePidFile` there (pure leaf, already owns `pidFilePath`, both modules already import it — no cycle). `daemon-control.ts` imports it; `probeDaemon` unchanged. Delete `readPidIdentity` and the inline parse in `removePidFile`; both use the shared parser (the strict result is a superset of what they need).

## Constraints

- Liveness model untouched: no freshness windows, nothing time-based.
- `probeDaemon`'s four typed reasons (`no-pidfile`, `bad-pidfile`, `dead-process`, `snapshot-mismatch`) preserved exactly — bad file still parses to `null` → `bad-pidfile`.
- `removePidFile` self-check preserved: unlink only when the file's pid AND token equal this process's own.
- No forced uniformity beyond removing the duplication; `daemon-control` keeps its own probe.

## LOC

- `locks.ts` +~22. `daemon.ts` −~53 (enumeration + PID parts, incl. dead imports). `daemon-control.ts` −~14. `home.ts` +~15. Net ≈ −30; 4 hand-rolled parse/enumerate copies → 2 single-sourced.

## Acceptance

- [ ] `holders()` in `locks.ts` returns `{name, pid}` for live plugin locks only; `qmd-*` and `daemon-start` excluded
- [ ] `readRunningPlugins` and `RunningPlugin` deleted; all 3 call sites use `holders()`
- [ ] now-unused `readdir`/`join`/`locksDirPath`/`isPluginLock` imports removed from `daemon.ts`
- [ ] one `parsePidFile` in `home.ts`; `readPidIdentity` and the inline parse in `removePidFile` gone
- [ ] `probeDaemon` returns the same typed reasons on missing / corrupt / dead / mismatched files
- [ ] `removePidFile` still unlinks only on matching pid + token
- [ ] enumeration test (`daemon.test.ts:114`) passes against `holders`; existing `locks`/`daemon-control` tests unchanged
- [ ] net line count drops; no new file
