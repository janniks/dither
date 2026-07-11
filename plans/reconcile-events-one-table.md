# Plan: reconcile events — one wire, delete the middle layer

> Source spec: `specs/reconcile-events-one-table-DRAFT.md`

## Architectural decisions

- Summary types move into reconcile-sink.ts; `reconcile-protocol.ts` deleted.
- `reconcileHandler` keeps its `{sink, line, jobsRun}` shape (test churn stays low); `line` reads `_dither` directly and calls the matching sink method.
- `job-failed` / `reconcile-failed` carried on the wire; exit-code inference stays as fallback, guarded so a wire-carried failure isn't journaled twice.

---

## Phase 1: carry failures on the wire, delete the protocol layer

**Acceptance:**
- [x] `reconcile-protocol.ts` deleted; nothing imports it
- [x] parity test: dispatching stderrSink-emitted lines produces the same journal as journalSink directly
- [x] child-path run-log carries real jobFailed/reconcileFailed error strings
- [x] native crash (no failure line, nonzero exit) journals reconcile-failed + reconcile-done (failed) exactly once
- [x] fewer total lines across the touched files

---

## Phase log

|  |  |
|--|--|
| 03510c8 | Phase 1: failures on the wire, protocol layer deleted |
