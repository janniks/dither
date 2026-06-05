# How established queues do durability + handoff (survey)

Context: designing daemon version-restart + WAL-durable fire sources. Surveyed
6 system families to avoid reinventing. Conclusion: **our design is the
standard one** — keep the filesystem substrate, steal the semantics.

## The table

| System | Default delivery | "Exactly-once" = | Claim / redelivery | Restart / handoff | Top steal |
|---|---|---|---|---|---|
| SQS (+FIFO) | at-least-once (FIFO EO-*delivery* via dedup-ID, 5min) | idempotent consumer | **visibility timeout**: no Delete in time → reappears | stateless; lease lapses → redeliver | inflight as a **live lease**, not boot-only |
| Kafka | at-least-once | idempotent producer + txns (in-Kafka only) | **committed offset**, commit *after* process | consumer-group **rebalance**, commit on revoke | offset = **cursor committed after processing** → watcher watermark / scheduler lastRun |
| RabbitMQ | at-least-once (manual ack) | idempotent consumer + confirms | unacked → **requeue on disconnect**; prefetch cap | basic.cancel → finish → disconnect | **completion-gated** drain; prefetch = global concurrency cap |
| Job queues (Sidekiq/Celery/BullMQ) | at-least-once ("jobs must be idempotent") | unique-job / idempotency keys | processing-set + **stalled-checker** sweep | **quiet → drain → push stragglers** (TSTP→TERM) | Sidekiq quiet/drain **is** our drain-non-blocking restart |
| Temporal | workflow EO-*effect* / activity at-least-once | **deterministic replay** of durable history + idempotency keys | poll task-queue; startToClose/heartbeat timeout | **stateless workers**: kill & replace, replay | "state in durable history, worker disposable → kill-and-replay" = our restart model |
| DB queue + outbox/inbox | at-least-once (EO-delivery if ack shares work's txn) | outbox + **inbox dedup table** | locked_until + SKIP LOCKED | stop claiming; lease expiry recovers | processed(key) dedup table = EO-effect escape hatch |

## What all six agree on

1. **Nobody ships free exactly-once *delivery*.** Universal model =
   at-least-once delivery + idempotent/transactional consumer = exactly-once
   *effect*. Validates our transactional-runs decision.
2. **A claim is a *lease*, not a delete.** Lease expiry auto-redelivers.
   dither's inflight→recover is this, but boot-only.
3. **Graceful restart = quiet → drain → hand off**, completion-gated, hard-cap
   fallback that requeues stragglers (Sidekiq is the exact template).
4. **Most robust = stateless workers over a durable log; kill & replay**
   (Temporal, Kafka). State on disk, never authoritative in-process.
5. **Single-active-per-key = a lock/partition; parallelism = many keys.**
   dither's per-plugin lock already is Kafka's partition-owner.

## The fork it surfaced — and our call

Move the queue into SQLite (outbox/inbox, SKIP LOCKED)? **No.** Two
dither facts kill the DB-queue prize:
- processing is **cross-process child workers** (Deno) that can't share the
  daemon's SQLite handle (native handles are process-local — proven in the
  embed work);
- the real effects are **filesystem** (`.md`, `state.json`), so the outbox
  "ack in the same txn as the effect" can't apply — you'd still need
  transactional runs.

So a DB queue adds a file/DB split for ACID bookkeeping a single-writer
daemon doesn't need. **Keep files; steal the semantics.** Reserve a
`processed(key)` dedup table only as a narrow opt-in for a future
non-idempotent plugin.

## Upgrades folded into the specs

- **Spec B:** watcher **watermark** + scheduler **lastRun** = Kafka's
  committed-after-processing cursor; inflight recover stays (live-lease
  deferred — see [[daemon-restart-followups]]).
- **Spec A:** restart = **quiet → drain → push-stragglers**, framed as
  Temporal stateless kill-and-replay; separate longer `RESTART_DRAIN_MS`.
