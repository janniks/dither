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
- [x] Module-level mutex serializes `appendAt(runLogPath(), …)` calls inside the process. (already landed in 64b51ec)
- [x] Per-Run appends use per-runId chains (not blocked by global chain). (already landed in 64b51ec)
- [x] `rotate()` is ENOENT-tolerant on both `unlink(.old)` and `rename(path,oldPath)`.
- [x] New test fills the log near threshold, fires multiple parallel `appendGlobal` calls, asserts no throw, all events present across `path` + `.old`, `.old` non-empty. (already landed in 64b51ec)
- [x] Existing run-log tests still pass.

---

## Phase 4: SIGHUP-vs-follower race in `triggerAndWatch`

**User stories**: 1

End-to-end behavior: `triggerAndWatch` cannot lose the `reconcile-started` event even when the daemon's SIGHUP handler runs faster than the follower's `open()`.

**Acceptance:**
- [x] `triggerAndWatch` snapshots the global log byte offset before sending SIGHUP, so a `reconcile-started` emitted between SIGHUP and follower-open is still inside the read window. (Used byte-offset snapshot instead of eager-open; the lazy `async function*` shape stays.)
- [x] `watchReconcile` accepts `fromOffset` in `WatchOptions` and passes it through to the transport's `follow`.
- [x] `DaemonTransport.follow` takes an optional `fromOffset`; default impl delegates to `followGlobal(signal, fromOffset)`.
- [x] New test asserts `snapshotOffset` is called before `signal` in `triggerAndWatch`.
- [x] All existing `daemon-client.test.ts` tests pass without modification (snapshotOffset is optional on the transport interface).

---

## Phase log

| Commit | Summary |
|--|--|
| 64d48b6 | Phase 1: guard `dither runs tail` against duplicate `_result` lines on slow disk |
| 9da0744 | Phase 2: widen `runId` random suffix to 4 bytes + retry on `mkdir` EEXIST |
| 458e71d | Phase 3: ENOENT-tolerant `rotate()` (per-path append serialization already landed in 64b51ec) |
| (this) | Phase 4: `triggerAndWatch` snapshots log offset before SIGHUP to close the race window |
