# Plan: DaemonClient seam

> Source spec: `specs/daemon-client-seam.md`

## Architectural decisions

- One module exports `daemonClient({transport?})` returning `signalReconcile`, `watchReconcile`, `triggerAndWatch`.
- `watchReconcile` is an `AsyncIterable<DaemonEvent>` — filters internal events; throws on `daemon-stopped` mid-reconcile or `DaemonDiedError` (PID dies).
- Liveness via dead-PID probe piggybacked on the **Run-log** poll tick — no timeout.
- DI-style test transport — no `VITEST_WORKER_ID` env sniffing.
- Per-jobId UI state stays in the renderer (init).
- Detach via `AbortSignal`: handlers unregister, follow loop stops, daemon untouched.

---

## Phase 1: Build `daemonClient` over the unified Run-log

**User stories**: 1, 2, 3

End-to-end: new module exposes the three methods over the **Run-log** global scope. The DI-style transport hook accepts a stub iterable for tests. No `init.ts` changes yet.

**Acceptance:**
- [ ] `daemonClient({transport})` returns `{signalReconcile, watchReconcile, triggerAndWatch}`.
- [ ] `watchReconcile` is an `AsyncIterable<DaemonEvent>` over the **Run-log** global scope.
- [ ] Internal events filtered; closed `DaemonEvent` union.
- [ ] Iterator throws `DaemonStoppedDuringReconcileError` on mid-reconcile `daemon-stopped`; throws `DaemonDiedError` if PID is ESRCH on a poll tick.
- [ ] Iterator completes on `reconcile-done`.
- [ ] AbortSignal aborts iteration cleanly; signal handlers unregister.
- [ ] Tests drive a stub transport: assert events, completion, errors, abort.

---

## Phase 2: Refactor `init.ts` to consume the seam

**User stories**: 1, 4, 5, 6

End-to-end: `init.ts` builds a `daemonClient`, calls `triggerAndWatch`, renders each event. SIGINT/SIGHUP handling collapses to one `AbortController` wired to Ctrl-C. Test-mode toggles via the transport, not env-sniffing.

**Acceptance:**
- [ ] `commands/init.ts` watch flow is a single `for await` loop.
- [ ] `VITEST_WORKER_ID` env check removed from init.
- [ ] Ctrl-C during init prints detach message and aborts cleanly; daemon survives.
- [ ] `--no-wait` still short-circuits before iteration starts.
- [ ] All `init.test.ts` assertions pass against the new shape (via stub transport).

---

## Phase log

|  |  |
|--|--|
|  |  |
