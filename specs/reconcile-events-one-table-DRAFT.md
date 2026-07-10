# Reconcile events — one wire, delete the middle layer

Cleanup, not a new abstraction. Keep every existing name (`ReconcileSink`, `jobStarted`, `jobDone`, `journalSink`, `stderrSink`). No new file, no new vocabulary. Net lines must go down.

## Problem

The same list of reconcile events is written out in five places. Adding one event means editing all five:

- `ReconcileSink` interface — 8 methods (`reconcile-sink.ts:17`)
- `journalSink` bodies (`reconcile-sink.ts:33`) — real journal writes
- `stderrSink` bodies (`reconcile-sink.ts:98`) — serialize to NDJSON
- `ReconcileMessage` union (`reconcile-protocol.ts:45`) + `parseReconcile` branches (`:67`)
- `reconcileHandler` switch (`reconcile-supervisor.ts:48`) — re-dispatch each parsed message back onto the sink

The union + parser + handler switch are three encodings of one event list, sitting between the child's stderr and `journalSink`, existing only to hand a typed object from parse to dispatch.

Two real bugs from this spread:

- `stderrSink.jobFailed` / `reconcileFailed` are no-ops (`reconcile-sink.ts:116,122`). The real error string from `reconcile-run.ts:243` never reaches the wire; the daemon journals a generic `reconcile child exited N`. The inline `journalSink` keeps the real string — same interface, different run-log.
- `stripEnvelope` keeps any numeric key (`reconcile-protocol.ts:112`) — `job-done` summaries are untyped on the wire.

## Solution

- Delete `reconcile-protocol.ts`. Move its 3 summary interfaces (`EmbedDoneSummary` etc., only consumer is `reconcile-sink.ts`) into `reconcile-sink.ts`.
- Delete the `ReconcileMessage` union, `parseReconcile`, `stripEnvelope`.
- Collapse `reconcileHandler`'s parse-then-switch into one `dispatch(line, sink)` in `reconcile-supervisor.ts`: read `_dither`, call the matching sink method, return `jobsRun` for `reconcile-done`. Non-`_dither` lines journal as `{kind:"stderr"}` (unchanged). The wire kind IS the sink method (kebab vs camel). Only two sides know the wire, both in files that already own it: `stderrSink` emits, `dispatch` reads. (Considered a metaprogramming table deriving both sides; rejected — the irregular cases make it more code and harder to read than two plain side-by-side functions.)
- Carry failures on the wire. `stderrSink.jobFailed` / `reconcileFailed` stop being no-ops and emit `{_dither:"job-failed", type, error}` / `{_dither:"reconcile-failed", error}`; `dispatch` routes them to the sink, so the daemon journals the real error string.
- Keep exit-code inference as the fallback. If the child dies without emitting `reconcile-failed` (native crash), the nonzero-close branch in `superviseReconcile` still emits `reconcile-failed` + `reconcile-done (failed)`. Guard with a flag so a failure that already arrived on the wire isn't journaled twice.

## Wire compatibility

- The child is spawned as the same script the daemon runs (`reconcile-supervisor.ts:82,88`) — emitter and reader ship together; no cross-version wire contract. Only skew window is a live old daemon spawning a freshly-swapped child: the new kinds are additive, an old reader journals them as stderr diagnostics, and exit-code inference still catches the failure. Degrades to today's behavior, never breaks.

## LOC

- `reconcile-protocol.ts` deleted (120 lines); ~17 lines of summary types relocated.
- `reconcile-supervisor.ts`: parse+switch → one `dispatch`, ~12 saved.
- `reconcile-sink.ts`: +17 relocated types, +~6 real failure bodies.
- Net: ~100 production lines genuinely deleted, ~12 added.
- Tests: delete `reconcile-protocol.test.ts`; its content folds into `reconcile-supervisor.test.ts` (round-trip) and `reconcile-child.test.ts` (plain `JSON.parse` of captured lines).

## Acceptance

- [ ] `reconcile-protocol.ts` deleted; nothing imports it
- [ ] round-trip test: `dispatch` of an `stderrSink`-emitted line produces the same journal as calling `journalSink` directly (parity inline vs wire)
- [ ] child-path run-log carries the real `jobFailed`/`reconcileFailed` error string, not `reconcile child exited N`
- [ ] a native crash (no failure line, nonzero exit) still journals `reconcile-failed` + `reconcile-done (failed)` exactly once
- [ ] adding a hypothetical event touches two spots (emit + dispatch), not five
- [ ] fewer total lines across the touched files than before
