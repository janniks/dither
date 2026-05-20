# Plan: Refactor bug fixes

> Source spec: `specs/refactor-bug-fixes.md`

## Architectural decisions

- **No new public surface.** All fixes are internal to `run-log.ts`, `daemon-client.ts`, `commands/runs.ts`. The Run-log API (`appendGlobal`, `appendRun`, `openRun`, `followGlobal`, `followRun`, `listRuns`) and the daemonClient seam (`signalReconcile`, `watchReconcile`, `triggerAndWatch`) are unchanged for callers.
- **In-process mutex for global appends.** Module-level promise chain in `run-log.ts`; per-Run appends keep their own per-runId chains. No file locking — cross-process global writers are out of scope.
- **runId stays opaque.** Suffix widens 2→4 bytes; `openRun` retries up to 3 times on `EEXIST`. Format `<stamp>-<plugin>-<rand>` preserved.
- **Iterator-open semantics.** `watchReconcile`'s follower-open moves before `signalReconcile`'s SIGHUP send inside `triggerAndWatch`. Direct callers of `watchReconcile` get the same eager-open behavior so single-call use stays predictable.

---

## Phase 1: Single `_result` line on `dither runs tail`

**User stories**: 4

End-to-end behavior this slice delivers: a user running `dither runs tail <runId>` against a Run that finishes mid-watch sees exactly one `_result` line on stdout regardless of disk latency.

**Acceptance:**
- [x] Re-entrancy guard added in the result-poll callback so the second-tick path is a no-op while the first read is in flight.
- [x] New test in `commands/runs.test.ts` drives the tail subcommand against a temp `DITHER_DIR`, simulates a slow `result.json` read, asserts exactly one `_result` line on captured stdout.
- [x] Existing tests still pass.

---

## Phase 2: Collision-free `generateRunId`

**User stories**: 2

End-to-end behavior: a plugin scheduled `every 1s` runs N times in close succession; all N Runs appear in `dither runs list` with distinct `runId`s and intact `manifest.json` files.

**Acceptance:**
- [x] `generateRunId` random suffix widened from 2 to 4 bytes.
- [x] `openRun` uses `mkdir({recursive:false})`; on `EEXIST`, regenerates runId and retries up to 3 times; otherwise throws.
- [x] New test stubs `randomBytes` to force a collision once and asserts both `openRun` calls succeed with distinct ids and intact manifests.
- [x] Existing run-log tests still pass.

---

## Phase 3: Race-free global Run-log rotation

**User stories**: 3

End-to-end behavior: with two concurrent `appendGlobal` calls crossing the 1 MB rotation threshold, neither throws, both lines land on disk, and exactly one rotation occurred.

**Acceptance:**
- [ ] Module-level mutex serializes `appendAt(runLogPath(), …)` calls inside the process.
- [ ] Per-Run appends use per-runId chains (not blocked by global chain).
- [ ] `rotate()` is ENOENT-tolerant on both `unlink(.old)` and `rename(path,oldPath)`.
- [ ] New test fills the log near threshold, fires multiple parallel `appendGlobal` calls, asserts no throw, all events present across `path` + `.old`, `.old` non-empty.
- [ ] Existing run-log tests still pass.

---

## Phase 4: SIGHUP-vs-follower race in `triggerAndWatch`

**User stories**: 1

End-to-end behavior: `triggerAndWatch` cannot lose the `reconcile-started` event even when the daemon's SIGHUP handler runs faster than the follower's `open()`.

**Acceptance:**
- [ ] `watchReconcile` opens its follower eagerly (before the first `yield`), so the file is being watched the moment the function returns its iterable.
- [ ] `triggerAndWatch` opens the follower first, then sends SIGHUP, then yields.
- [ ] New test stubs the transport so `signal()` synchronously emits `reconcile-started`; asserts `triggerAndWatch` consumes the cycle and completes on `reconcile-done` rather than hanging.
- [ ] All existing `daemon-client.test.ts` tests pass without modification.

---

## Phase log

|  |  |
|--|--|
|  |  |
