# Plan: Durable fire sources

> Source spec: `specs/durable-fire-sources.md`

## Architectural decisions

- **Deep module — `Queue<T>` (per-plugin, durable):** `enqueue(item)` +
  `drain(run)`; internally claim → run → `ack` | `restore`, plus boot
  `recover`. Hides atomic tmp+rename, storage shape, dedup, the inflight lease.
  Filesystem substrate (no SQLite). One file per identity.
- **`Source` interface:** `start(emit)` (live) + `recover(emit)` (boot
  re-derive) + `stop()`. Sources stay distinct, thin adapters. Depth is in the
  Queue, never the sources.
- **Delivery:** at-least-once + transactional/idempotent processing =
  exactly-once *effect*. Claim = lease; ack on success, restore on failure;
  boot recovery re-queues unacked. No timers, no sweep.
- **Plugin run = transaction:** stage `state.json` in `runs/<runId>/`, commit
  atomically with promotion, roll back on interruption.
- **Consumer:** `fireWithSuppress` choke point; per-plugin lock =
  single-active-per-key; cross-plugin concurrency.

---

## Phase 1: The Queue deep module + kicks as first consumer

**User stories**: "every source shares one durable-queue abstraction."

Build `Queue<T>` (durable, per-identity: enqueue/drain/claim/ack/restore/
recover) and migrate **kicks** — the simplest already-durable source — onto it,
proving the abstraction end-to-end. Define the `Source` interface and make kicks
the first `Source`.

**Acceptance:**
- [x] `Queue<T>` module: enqueue is atomic+durable; drain claims, runs, acks on
      success, restores on failure; recover re-queues unacked at boot.
- [x] Kicks flow through `Queue` (`plugin run` still works end-to-end; a kick
      left on disk is drained on boot).
- [x] `Source` interface defined; kicks implemented as a `Source`.
- [x] Tests: real-impl queue round-trip (enqueue→drain→ack), restore-on-failure,
      recover-on-boot. Existing kick/plugin-run tests pass.

**Review notes (carry to Phase 6):**
- `Source.emit` is **vestigial for kicks** — the CLI writes the kick file before
  the daemon hears about it, so the kick source only *drains*, never *emits*.
  Watch whether `emit` stays the right shape once watcher/scheduler (live
  producers that observe-then-enqueue) land in P3/P4.
- `kickSource` returns `Source & { drain() }` — a test seam. Fold into the
  interface only if every source needs it; else it's a kick-specific wart.
- Kick `Outcome` is always `"done"` (`fireWithSuppress` swallows run errors), so
  kick at-least-once rests on crash-before-ack + boot recover, not a `"retry"`
  signal. The `retry`/`log` path is exercised by inbox in P5.
- One inline `else` in `queue.ts:168` slips the no-`else` rule — tidy in P6.

---

## Phase 2: Plugin run = transaction (state atomicity)

**User stories**: "I commit output and state atomically, or roll back entirely."

Stage `state.json` in `runs/<runId>/` (seeded from committed state), repoint
`DITHER_STATE_FILE`, grant write to `runDir` only, and commit state atomically
alongside promotion on clean finish. Interrupted run → discarded → state rolls
back with output.

**Acceptance:**
- [x] State seeded into the run dir; `DITHER_STATE_FILE` points there; sandbox
      write-grant no longer includes the persistent `state/`.
- [x] Clean finish commits state atomically (tmp+rename) with promotion.
- [x] Interrupted run leaves the committed state unchanged and nothing promoted.
- [x] Tests: committed-then-visible on success; unchanged on interruption (real
      impl, no mocks).

---

## Phase 3: Watcher onto the Queue + watermark recover

**User stories**: "no watch event is lost because I was down."

Migrate the watcher to a `Source` over `Queue`; add a per-collection mtime
**watermark** and a boot `recover` catch-up scan that enqueues files changed
during downtime.

**Acceptance:**
- [ ] Watcher is a `Source` (`start` = chokidar→emit; `stop`).
- [ ] Watermark persisted per watched collection; advanced as events flow.
- [ ] `recover` scans `watch.collections`, enqueues `mtime > watermark`.
- [ ] Test: change a file while the watcher is stopped → `recover` enqueues and
      fires it on next drain.

---

## Phase 4: Scheduler onto the Queue + lastRun recover

**User stories**: "no scheduled tick is lost because I was down."

Make the scheduler a `Source`: persist `lastRun` per schedule; boot `recover`
does anacron-style catch-up (a missed tick fires once; N missed → 1).

**Acceptance:**
- [ ] `lastRun` persisted per schedule; updated on each fire.
- [ ] `recover` fires once if a run was due during downtime (collapses misses).
- [ ] Live cron tick enqueues via `emit`.
- [ ] Test: simulate downtime spanning a due tick → exactly one catch-up fire.

---

## Phase 5: Refirer + inflight unified; lifecycle = recover-all + drain

**User stories**: maintainer — durability lives in one module, not scattered.

Bring the refirer under the `Source` interface and route inflight recovery
through the `Queue`. Express daemon boot / SIGHUP as **recover all sources +
drain the queue**. Delete the now-redundant bespoke durability code
(scattered `restoreInflight`/`scanKicks`/ad-hoc recovery call sites).

**Acceptance:**
- [ ] Refirer is a `Source`; inflight recovery is the Queue's `recover`.
- [ ] Daemon boot + SIGHUP = `recover all + drain` (single uniform path).
- [ ] Dead/duplicated durability code removed (net deletion).
- [ ] Full daemon/source/queue suites pass.

---

## Phase 6: Review the abstraction

**User stories**: "try this abstraction and review later to see how it ended up."

Step back: did `Queue`/`Source` land as a deep module, or did a source resist?
Either tidy the interface or document the divergence in the spec. No new feature
work — this is the deliberate review pass.

**Acceptance:**
- [ ] Each source is a thin `Source`; no source leaks queue internals.
- [ ] Interface reviewed for depth (small surface, complexity hidden); divergence
      (if any) documented in `specs/durable-fire-sources.md`.
- [ ] Note for follow-ups confirmed (no timers/sweep introduced).

---

## Phase log

When starting implementation, rename to `plans/durable-fire-sources-RUNNING.md`.
Work one phase at a time, ticking acceptance criteria, committing only that
phase's changes, then continue. Append a row after each phase. Rename back when
all phases complete.

| commit | summary |
|--|--|
| P1 | `Queue<T>` deep module (latest/log shapes, claim/ack/restore/recover) + `Source` interface; kicks migrated as first Source; `plugin run` intact. Typecheck clean, 38 pass + daemon suite clean (1 pre-existing deno fail) |
| P2 | Plugin run = transaction: state staged in `runs/<runId>/state.json` (seeded from committed), `DITHER_STATE_FILE` repointed, write-grant tightened to `runDir` only, atomic tmp+rename commit alongside `promote` on clean exit; rollback via existing `rm -rf` finally. Injectable `spawn` seam threads through to `supervise`. Typecheck clean; plugin-run/supervisor/promotion 28 pass; full suite 43 pre-existing deno fails unchanged (+3 new tests, 0 new fails) |
