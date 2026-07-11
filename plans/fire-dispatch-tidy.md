# Plan: fire choke point — stop dropping busy kicks; drop the threading

> Source spec: `specs/fire-dispatch-tidy-DRAFT.md`

## Architectural decisions

- `makeFire(state, deps)` in daemon.ts binds `{watcher, refirer, detector, notify, postRun}` once; returns `fire(name, trigger, kick?) → Outcome`. `fireKick` deleted; busy/gated/halted → `"retry"` (queue keeps the kick), run attempted → `"done"`.
- `postRun(name)` fires only after an actual run (after lock release + refire pickup) — a busy fire spawns no post-run, so the re-drain can't loop. It re-drains pending kicks; the deferred-reindex spec's sweep joins the same hook later (signature `(name) => void`).
- Refire-pickup read error is logged, not nulled silently.

---

## Phase 1: makeFire + busy-kick retry + post-run re-drain + tests

**Acceptance:**
- [x] kick during a held plugin lock is not dropped; re-fires with original runId when the lock frees (test)
- [x] `fire` ≤3 args at all call sites; no "export for tests only" of internals
- [x] refire read error logged, not swallowed
- [x] backfill trigger=watch regression tests green
- [x] post-run re-drain terminates with no pending kick

---

## Phase log

|  |  |
|--|--|
|  |  |
