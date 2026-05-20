# Spec: Bug fixes from refactor-series review

> Origin: dry-run review of `fa3df01..HEAD` (the 5-refactor series).
> Scope: correctness only. Quality / efficiency findings deferred.

## Problem Statement

The recent refactor series introduced four correctness defects in `run-log.ts` and its callers. Each is reachable from normal product use; each is silent (no crash, just wrong behavior or hung iterators). Users see: occasional `dither init` watch hanging until Ctrl-C, lost Run history when schedules tick fast, occasional uncaught ENOENT on log rotation, and duplicate `_result` lines on `dither runs tail`.

## Solution

Fix all four in one focused pass. The Run-log shape and daemon-client seam stay intact — these are bugs in their implementations, not their interfaces.

## User Stories

1. As a user running `dither init` in a quiet repo, I want the watch flow to reliably complete on `reconcile-done`, so that I never see it hang silently when the daemon was fast enough to start the reconcile before my watcher opened.

2. As a user with a fast schedule (e.g. `every 1s`), I want every Run to land in `dither runs list` with its own manifest and result, so that no Run silently overwrites another's history record.

3. As a user with a long-lived daemon whose global Run-log eventually crosses 1 MB, I want log rotation to be race-free, so that I never see an uncaught `ENOENT` propagating out of a routine `appendGlobal` call.

4. As a user running `dither runs tail <runId>` against a Run that finishes while I'm watching, I want exactly one `_result` line printed, so that the tail output is parseable by downstream JSONL consumers.

## Implementation Decisions

### Bug 1 — `watchReconcile` misses `reconcile-started` (race)

**Defect.** `daemonClient.triggerAndWatch` calls `signalReconcile()` (sends SIGHUP, returns), then `watchReconcile()` which calls `t.follow(...)` → `followAt(runLogPath)` → opens the file and sets `offset = st.size` (run-log.ts:195-196). If the daemon processes SIGHUP and emits `reconcile-started` before the follower's `open()` resolves, the event sits below `offset` and is never seen. Consumer-side: `cycleStarted` never flips true (daemon-client.ts:164-167), every subsequent event hits the `if (!cycleStarted) continue` filter at line 168, and the iterator hangs until the daemon dies or the caller aborts.

**Fix.** Swap the order in `triggerAndWatch`: open the follower **before** sending SIGHUP. Concretely, expose a "follow from current end, return the iterable immediately" capability that begins watching synchronously, then signal, then yield. The simplest shape: `triggerAndWatch` becomes

```
const iter = watchReconcile({ pid, signal });          // opens follower at current EOF
await signalReconcile();                                // now safe to SIGHUP
yield* iter;
```

This requires `watchReconcile` to do the file-open eagerly (before the first `yield`). The current async generator opens lazily on first iteration. Refactor: make `watchReconcile` return a started AsyncIterable whose first internal `await` (the `t.follow` open) is initiated at call time, not at first `next()`. Concretely, kick off the open in a queued promise and have the generator await it before its first loop iteration.

No new public surface. `signalReconcile()` and `watchReconcile()` are unchanged for direct callers; only `triggerAndWatch` changes order.

### Bug 2 — `generateRunId` collision under fast schedules

**Defect.** `generateRunId(plugin)` (run-log.ts:304-311) is `<UTC-second>-<sanitized-plugin>-<2-byte-hex>`. Two Runs of the same plugin in the same UTC second collide with probability `1/65536`. `openRun` then `mkdir(dir, { recursive: true })` (line 329) silently succeeds on the existing directory and overwrites `manifest.json` (line 336). The first Run's history record is lost; its `events.jsonl` may also interleave with the second Run's events.

**Fix.** Two changes:
1. **Widen the random suffix to 4 bytes** (`randomBytes(4).toString("hex")`). Collision probability drops to `1/2³²` per same-second pair — sufficient for any realistic schedule.
2. **Detect collision at `openRun`.** Replace `mkdir({recursive:true})` with `mkdir({recursive:false})`; on `EEXIST`, regenerate the runId and retry (bounded to 3 attempts). After 3 failures, throw — at that point the clock is broken or `randomBytes` is degenerate. This converts a silent-overwrite into a loud failure.

### Bug 3 — `rotate()` ENOENT race on `.old`

**Defect.** `appendAt` (run-log.ts:104-120) stats the file, decides whether to rotate, calls `rotate()` (line 250-255), then opens and writes. Two `appendGlobal` calls in the same Node process can interleave between awaits:

- Call A: `statSync` → over threshold → starts `rotate()`
- Call B (interleaved): `statSync` → also over threshold → starts `rotate()`
- A: `existsSync(.old)` true → `await unlink(.old)` succeeds
- B: `existsSync(.old)` true (race window) → `await unlink(.old)` → **ENOENT throws, uncaught**

The throw bubbles out of `appendGlobal`, surfacing to whatever was logging (daemon heartbeat, job emitter). Daemon callers swallow with `.catch(() => undefined)` so the outcome is a lost log line, not a crash — but the rotation also leaves the file unrotated, so the threshold drifts upward unboundedly until the next clean rotation.

**Fix.** Two changes:
1. **Serialize global appends with an in-process mutex.** A single module-level promise chain: each `appendGlobal` call appends its work onto the chain, ensuring `stat → rotate → open → write` runs atomically per call. Per-Run appends (`appendRun`) keep their own per-runId chains. This makes the threshold check + rotate sequence race-free within the process.
2. **Make `rotate()` ENOENT-tolerant** as defense in depth: replace the `existsSync(.old) ? unlink(.old)` pre-check with `unlink(.old).catch(ignoreENOENT)`. Same for the rename — `rename(path, oldPath).catch(ignoreENOENT)`.

Cross-process races (e.g. plugin subprocess writing global log) are not possible today: only the daemon process writes the global log. If that invariant changes, the in-process mutex is no longer sufficient and a file-locked rotation will be needed — out of scope here.

### Bug 4 — `runs tail` double `_result` emission

**Defect.** `commands/runs.ts:93-100` uses `setInterval(..., 100)` to poll `result.json`. Inside the callback: `if (existsSync(...)) { void readResult(...).then(r => { console.log(...); ac.abort(); }) }`. The interval is not paused while `readResult` is in flight. On a slow disk, two interval ticks fire before the first read resolves; both find the file present, both kick off `readResult`, both log `_result`, both abort (idempotent). Output corrupted with a duplicate JSONL line.

**Fix.** Add an in-flight guard: a `resultEmitted` boolean (or just check `ac.signal.aborted` at the start of the callback). The simplest correct shape:

```
let emitted = false;
const resultPoll = setInterval(() => {
  if (emitted || !existsSync(resultPath(runId))) return;
  emitted = true;
  void readResult(runId).then((r) => {
    if (r) console.log(JSON.stringify({ type: "_result", ...r }));
    ac.abort();
  });
}, 100);
```

Set `emitted = true` synchronously before launching the read so the next tick is a no-op.

## Testing Decisions

### What makes a good test

External behavior only. No spying on internal state machines; no asserting on private mutex chain. Tests drive the public surface (`appendGlobal`, `openRun`, `daemonClient.triggerAndWatch`, the CLI subcommand) and assert on observable outcomes (file contents, iterator yields, stdout).

### Modules to test

- **`run-log.ts`** — three new tests:
  1. **rotation under concurrent appends**: fill log to just under threshold; fire N parallel `appendGlobal` calls each crossing it; assert no throw, all lines preserved across `path` + `.old`, `.old` is non-empty.
  2. **`openRun` collision**: monkey-patch `randomBytes` to a deterministic stub that returns the same bytes twice then different bytes; call `openRun(plugin, trigger)` twice in the same fake-clock second; assert both succeed with distinct `runId`s, neither manifest overwritten.
- **`daemon-client.ts`** — one new test added to `daemon-client.test.ts`:
  1. **SIGHUP-vs-follower race**: stub transport whose `signal()` synchronously calls `emit({kind: "reconcile-started"})` *before* returning (i.e. simulating a daemon that handles SIGHUP within the same microtask). Assert `triggerAndWatch` consumes the cycle and completes on `reconcile-done` rather than hanging.
- **`commands/runs.ts`** — one new test for the tail subcommand:
  1. **single `_result` line**: drive `tail` with a runId whose `result.json` appears mid-poll; assert exactly one `_result` line on stdout. Can be done by importing the subcommand's `run` function directly (citty's `defineCommand` exposes it) and capturing `console.log`.

### Prior art

- `run-log.test.ts` already has 8 tests covering append/read/follow/rotate. The two new tests follow the same fixture pattern (temp `DITHER_DIR`, direct `appendGlobal` calls, sometimes `Promise.all`).
- `daemon-client.test.ts` already has a `stubTransport` factory with the `state` + getter pattern. The new test reuses it; only the stub's `signal()` impl changes.
- `commands/runs` has no test file today; create `commands/runs.test.ts` using the temp-`DITHER_DIR` pattern from `daemon.test.ts`.

## Out of Scope

- All quality / efficiency findings from the same review (narrating comments, duplicated `isPidAlive`, `readFromPath` reads the whole file even with `tailLines`, `listRuns` N+1, dead `RENDERABLE` branch, etc.). Worth doing, but not bugs.
- Cross-process global-log writers. Today only the daemon writes the global log; if/when plugin subprocesses also write, replace the in-process mutex with file locking.
- Changing the rotation policy (size threshold, `.old` retention count). Reviewing the threshold is a separate decision.
- The `as DaemonEvent` casts — typing nit, not a runtime defect.

## Further Notes

- Bug 1 fix changes the order of operations in `triggerAndWatch` but keeps `signalReconcile` and `watchReconcile` public surfaces unchanged. Production callers (only `commands/init.ts`) need no edits.
- Bug 2 fix is observable to users only as "two runs of the same plugin in the same second now both show up in `dither runs list`". Spec previously documented runId as opaque, so widening the suffix is non-breaking.
- Bug 3's in-process mutex adds ordering inside a single process. It does **not** turn `appendGlobal` into a totally-ordered global queue across processes — daemon assumption holds.
- Bug 4 fix is one line of state + an early return. Test is short.
