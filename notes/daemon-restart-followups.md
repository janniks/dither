# Daemon restart / durable-queue — deferred follow-ups

Decided to leave these OUT of the first specs. Noted so we don't lose them.
None are needed for the core design to be correct.

## Lazy sweep / live inflight lease (maybe never)

- Borrowed from SQS visibility-timeout + job-queue stalled-checker: stamp
  inflight rows with `leaseExpiresAt` + `childPid`, and recover an orphan
  *without waiting for a daemon restart*.
- **Not now. No timers** (explicit). If we ever want it, make the sweep
  **lazy** — run it on the same IPC entry points as the staleness check
  (SIGUSR1 / SIGHUP), never on a background timer. Cost: a dead child isn't
  healed until the next IPC. Acceptable; boot-recovery + drain already cover
  the restart path. **Maybe we never need it.**

## Global concurrency cap (RabbitMQ prefetch)

- dither currently has **no** cap on concurrent plugin children — N distinct
  plugins fire N children. A flood of kicks could fan out widely.
- Bounded only by per-plugin locks + arrival rate today. A `maxConcurrent`
  knob (queue the overflow, which is already durable) would mirror AMQP
  prefetch. Nice-to-have, not required.

## Staleness check on watcher / scheduler fires (Q4 follow-up)

- Currently the version check fires only on external IPC (SIGUSR1, SIGHUP).
- Extending it to internal scheduler/watcher fires needs durably capturing
  "what woke me" before restart so the successor resumes it — kicks get this
  for free (durable file); in-memory timer/watch triggers don't. Once Spec B
  makes scheduler (`lastRun`) and watcher (`watermark`) durable, a missed
  internal fire is caught by boot catch-up anyway, so this may be moot.

## Per-plugin exactly-once dedup key (escape hatch)

- The whole design is at-least-once delivery + transactional runs =
  exactly-once *effect*. If a future plugin has a **non-idempotent external
  side-effect** (charges money, posts to an API) that a redo would
  double-apply, give *that plugin* an opt-in `processed(key)` dedup check —
  not a system-wide exactly-once-delivery store. See [[queue-patterns-survey]].
