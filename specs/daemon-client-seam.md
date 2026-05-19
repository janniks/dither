# DaemonClient seam

> Architectural deepening — extracts ~100 lines of daemon-client orchestration from `commands/init.ts` behind a testable seam.

## Problem Statement

`commands/init.ts` is 467 lines. Roughly 100 of those lines (`watchDaemonReconcile`, its helpers, the SIGINT/SIGHUP handlers, the watchdog, the per-`jobId` event router, the `handleJobEvent` UI dispatcher) implement what amounts to a **client of the Daemon** — a thing that:

- triggers a **Reconciler** pass via SIGHUP,
- subscribes to **Run-log** global-scope events,
- waits for `reconcile-done`,
- routes per-**Job** events to per-job UI state,
- detects daemon death mid-stream and recovers,
- detaches on Ctrl-C without killing the daemon.

There is exactly one caller (init), so today the logic lives inline. As a result:

- The orchestration has zero unit-test coverage. Tests bypass the whole branch via `VITEST_WORKER_ID`.
- Future callers (`dither watch`, `dither index update --wait`, `dither plugin run --watch`) would each copy a chunk of this state machine.
- The init command file mixes "render the init flow" with "be a client of the daemon" — two concerns at very different abstraction levels.

## Solution

A **DaemonClient** module that hides the SIGHUP-trigger, **Run-log** subscription, watchdog, and detach handling behind one async-iterable interface. The init command becomes a thin renderer over the iterable: each yielded **Job** event maps directly to a line of CLI output.

```
const client = daemonClient();
for await (const event of client.watchReconcile({ signal })) {
  render(event);
}
```

The signal is a standard `AbortSignal`. Cancelling it detaches: the SIGHUP listener unregisters, the **Run-log** follow loop stops, and the daemon keeps running.

## User Stories

1. As an init-command author, I want to write the init flow as a loop over events, so that the rendering code is straight-line and reviewable.
2. As a test author, I want to exercise the daemon-client logic with a fake **Run-log**, so that I can assert on event routing, timeout, and detach behaviour without spawning a real daemon.
3. As a future `dither watch` author, I want one library call to subscribe to **Reconciler** activity, so that I do not re-derive the SIGHUP-and-follow state machine.
4. As a user pressing Ctrl-C during init, I want a graceful detach, so that I keep my background work running while reclaiming my terminal.
5. As a user whose daemon crashes mid-reconcile, I want the client to notice and surface a clear error, so that I am not left staring at a frozen progress bar.
6. As a user re-running init while a previous reconcile is mid-flight, I want the client to attach to that reconcile, so that I do not double-trigger.

## Implementation Decisions

### Interface shape

**Q5 decided: (a) AsyncIterable.** Right primitive for a finite event stream with a known terminator (`reconcile-done`). Init renderer becomes literally a `for await` loop; tests use `async function*` stubs. Callback and EventEmitter alternatives rejected — callbacks push the "have I seen reconcile-done" state machine into every caller; EventEmitter has no ordering guarantees and silent error swallowing.

- `daemonClient()` returns an object with `watchReconcile(opts) → AsyncIterable<DaemonEvent>` and `signalReconcile() → Promise<{triggered, pid?}>`. Most callers use `watchReconcile` alone, which signals first and then follows.
- `DaemonEvent` is a discriminated union derived from **Run-log** event kinds — `job-started`, `job-progress`, `job-done`, `model-download-progress`, `reconcile-done`.
- **Q10 decided: (a) filter inside the seam.** Internal events (`daemon-started`, rotation noise) never reach the renderer. A future `--verbose` mode would be a separate opt-in flag, not a different default.
- **Q11 decided: (b) throw on daemon-stopped mid-reconcile.** A daemon that vanishes before `reconcile-done` is a failure mode. The iterable throws `DaemonStoppedDuringReconcileError` so the renderer can distinguish "all done" from "daemon walked off the job". On clean reconcile completion the iterable returns normally; only mid-stream `daemon-stopped` throws.
- The iterable also aborts (throws) on `signal.aborted` or `DaemonDiedError` (see Liveness check below).

### Detach behaviour

- The client owns its SIGINT and SIGHUP handlers for the duration of the iteration. On `signal.aborted`, handlers unregister and the **Run-log** follow loop stops. The daemon process is untouched.
- Init wires Ctrl-C to abort: the init handler catches one SIGINT, prints `↩ detached — daemon (pid N) keeps working`, and aborts.

### Liveness check (was: watchdog)

**Q9 decided: no time-based watchdog; piggyback dead-PID probe on the run-log poll tick.**
- The **Run-log** follower already polls the file at ~100 ms. On each poll, the seam additionally probes the daemon PID via `process.kill(pid, 0)` (cheap, single syscall).
- If the PID is ESRCH and the iterator is awaiting a next event, the iterable throws `DaemonDiedError`. Slow is fine; dead isn't.
- No timeout. **Jobs** can be silent for many minutes (model download, embed) and the iterator stays open.

### Reconcile semantics

**Q6 decided: (c) split methods, spawn side-effect on the write path only.**
- `signalReconcile()` — write semantic. Writes any **Marker** files the caller wants honoured (`needs-reindex`), starts the **Daemon** if not running, sends SIGHUP. Returns `{triggered: true, pid}`.
- `watchReconcile()` — read semantic. Pure observer over the **Run-log** global scope. Never spawns. A future `dither watch` calls this alone.
- `triggerAndWatch()` — convenience composition. Calls `signalReconcile()` then yields from `watchReconcile()`. Init uses this.

The daemon's existing coalescing behaviour means duplicate signals are safe.

### Inside the seam

- Reuses the **Run-log** `follow({kind: "global"})` from the unified log module.
- Reuses `daemon-control.ts` for start-on-demand and `readDaemonPid`.
- **Q8 decided: (a) per-jobId UI state lives in the caller.** The `ProgressLine` and `QmdDownloadCapture` instances keyed by jobId are the renderer's concern. The seam stays shallow on its surface (a single iterable) and deep on its mechanism. Renderer state belongs to the renderer.

### Init refactor

- `commands/init.ts` becomes substantially shorter. The watch flow collapses to a `for await` loop.
- The flag `--no-wait` continues to short-circuit the iteration before opening it.
- **Q7 decided: (b) DI-style test transport.** No `VITEST_WORKER_ID` env sniffing in production code. `daemonClient({transport})` accepts an optional transport — tests pass an empty-stub or controllable iterable; production constructs the real one from the **Run-log**. Tests that don't care pass the empty stub; tests that do care drive a controllable in-memory transport.

## Testing Decisions

- Test the seam through `watchReconcile`. Inputs: a controllable in-memory **Run-log** writer (or a temp-dir on-disk one). Outputs: the sequence of yielded events, completion vs throw, side-effects on signal handlers (count via `process.listenerCount`).
- Specifically cover: clean reconcile-done path; daemon-died-during-iteration; abort-via-signal mid-iteration; re-attach to an in-flight reconcile that has no SIGHUP-needed.
- Init's own tests stay focused on rendering: given a stub `daemonClient` that yields a fixed event sequence, assert the printed output. No more `VITEST_WORKER_ID` skips.

Prior art: `events-log.test.ts` already drives the follow loop with timing-sensitive appends. The new test file uses the same pattern.

## Out of Scope

- Replacing SIGHUP / **Run-log** with an HTTP or Unix-socket IPC channel.
- A standalone `dither watch` command (the seam unblocks it; the command is separate work).
- Streaming back-pressure or rate-limiting in the iterable.
- Multiplexing multiple concurrent watchers from one process.

## Further Notes

- This spec assumes **Run-log unification** has landed. If it hasn't, the seam still works but reads from `events-log.ts` directly and the API simplifies later.
- Naming: "DaemonClient" matches the conventional pattern (client of a long-lived service). "DaemonProxy" or "DaemonRPC" were considered and rejected as both overstate what is happening (signal + tail, not RPC).
