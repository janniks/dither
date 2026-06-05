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
- [x] Watcher is a `Source` (`start` = chokidar→emit; `stop`).
- [x] Watermark persisted per watched collection; advanced as events flow.
- [x] `recover` scans `watch.collections`, enqueues `mtime > watermark`.
- [x] Test: change a file while the watcher is stopped → `recover` enqueues and
      fires it on next drain.

---

## Phase 4: Scheduler onto the Queue + lastRun recover

**User stories**: "no scheduled tick is lost because I was down."

Make the scheduler a `Source`: persist `lastRun` per schedule; boot `recover`
does anacron-style catch-up (a missed tick fires once; N missed → 1).

**Acceptance:**
- [x] `lastRun` persisted per schedule; updated on each fire.
- [x] `recover` fires once if a run was due during downtime (collapses misses).
- [x] Live cron tick enqueues via `emit`.
- [x] Test: simulate downtime spanning a due tick → exactly one catch-up fire.

---

## Phase 5: Refirer + inflight unified; lifecycle = recover-all + drain

**User stories**: maintainer — durability lives in one module, not scattered.

Bring the refirer under the `Source` interface and route inflight recovery
through the `Queue`. Express daemon boot / SIGHUP as **recover all sources +
drain the queue**. Delete the now-redundant bespoke durability code
(scattered `restoreInflight`/`scanKicks`/ad-hoc recovery call sites).

**Acceptance:**
- [x] Refirer is a `Source`; inflight recovery is the Queue's `recover`.
- [x] Daemon boot + SIGHUP = `recover all + drain` (single uniform path).
- [x] Dead/duplicated durability code removed (net deletion).
- [x] Full daemon/source/queue suites pass.

**P5 notes (carry to Phase 6):**
- **SIGHUP** stays scoped: `onHup` does `reconcile()` + `refirer.reload()`
  only — it does NOT re-run the full `recoverAll` (no re-drain of kicks, no
  watch watermark re-scan, no schedule anacron re-fire). Routing SIGHUP
  through `recoverAll` would change behavior (re-fire owed work on every
  reload), so it was left out deliberately. Boot is the single uniform
  `recover all` path; reload is the lighter `reconcile + refire re-arm`.
  Decide in P6 whether that asymmetry is worth unifying.
- **Inbox lease layout divergence.** The inbox keeps its historical on-disk
  shape — pending `inboxes/<p>.ndjson`, lease `inflight/<p>.ndjson` (sibling
  dirs, not `inboxes/inflight/`). Expressed via a new `QueueConfig.inflightDir`
  override. Every other queue uses the default `<dir>/inflight`. Minor
  asymmetry; could migrate the inbox to the default layout in P6 if the
  on-disk break is acceptable.
- **`prefer` comparator.** Dedup gained an optional `prefer(a,b)` tie-break so
  the inbox keeps the *latest mtime* (not last-appended). Default stays
  last-wins. One extra config knob, but it's the only way to preserve the
  inbox's mtime semantics through the shared dedup.
- `Refirer.reload()` stays public (SIGHUP calls it); `recover` wraps it. `emit`
  is vestigial for refirer/kicks (they fire via their own closures) — same
  observation as P1's kick note.

---

## Phase 6: Review the abstraction

**User stories**: "try this abstraction and review later to see how it ended up."

Step back: did `Queue`/`Source` land as a deep module, or did a source resist?
Either tidy the interface or document the divergence in the spec. No new feature
work — this is the deliberate review pass.

**Acceptance:**
- [x] Each source is a thin `Source`; no source leaks queue internals.
- [x] Interface reviewed for depth (small surface, complexity hidden); divergence
      (if any) documented in `specs/durable-fire-sources.md`.
- [x] Note for follow-ups confirmed (no timers/sweep introduced).

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
| P3 | Watcher is a `Source`: `start`/`recover`/`stop` + kept `set`/`stats`/`suppressOnce`. New `watch-state.ts` persists a per-(plugin,collection) mtime watermark (`<home>/watch-state/<plugin>__<safe-collection>.json`), advanced on every live emit (best-effort) and in `recover`. `recover(emit)` walks each watched collection (`walkMd`), enqueues `mtime > watermark` honoring the glob, advances to max mtime, nudges a fire. Daemon boot calls `watcher.start(fire)` + `watcher.recover(fire)` after reconcile, uniform with kicks; inbox stays the store (Queue migration deferred to P5). Typecheck clean; watcher/inbox/watch-state 51 pass (+7 new tests), only the pre-existing deno `daemon.test.ts` fire-within-3s fail remains (0 new fails) |
| P4 | Scheduler is a `Source`: `start`/`recover`/`stop` + kept `set`/`stats`. New `schedule-state.ts` persists a per-plugin `lastRun` (`<home>/schedule-state/<plugin>.json`), advanced inside the croner callback (persist-then-fire) and in `recover`. `recover(emit)` is anacron catch-up: per active job `Cron.nextRun(lastRun)` — a scheduled time `≤ now` means a tick was missed → `emit(name)` once (N misses collapse to one), then `lastRun = now`. Empty `lastRun` (fresh install) seeds `lastRun = now`, no fire. Daemon boot calls `scheduler.start(fireScheduled)` + `scheduler.recover(fireScheduled)` through the `"scheduled"` `fireWithSuppress` choke point, uniform with watcher/kicks; `set()` reconcile path untouched. Typecheck clean; scheduler/schedule-state 13 pass (+8 new tests), only the pre-existing deno `daemon.test.ts` fire-within-3s fail remains (0 new fails) |
| P6 | Abstraction review (tidy + doc, no features). Dropped the vestigial `emit` from `Source.start` → `start(): void` in the interface + all 4 sources (kicks/watcher/scheduler/refirer) + the daemon's `recoverAll` loop (`source.start()`; `recover(emit)` keeps emit); updated 2 test call sites. The inline `else` flagged in P1 was already early-return after P5's `requeue` refactor (grep: 0 `else` in `queue.ts`). `prefer`/`inflightDir` confirmed minimal + well-commented (inbox's second shape), kept. `kickSource.drain()` confirmed test-only seam (daemon uses start/recover/stop), commented as such, not promoted. Added spec "## Review (P6)": Queue is a genuine deep module (inbox 169→74, boot = one recoverAll loop); Source is a thin honest contract; SIGHUP-stays-scoped + prefer/inflightDir + drain divergences documented as deliberate. No timers/sweep added (grep: 0 setInterval, 0 setTimeout in queue/kicks/inbox; watcher debounce + refirer per-row + croner pre-existing). Typecheck clean; queue/kicks/watcher/scheduler/refirer/inbox/daemon/plugin-run 91 pass, only the pre-existing deno fire-within-3s fail remains (0 new fails) |
| P5 | Consolidation. (a) `Queue` exposes decoupled `claim`/`ack`/`restore` (was private); `drain` = claim→run→ack\|restore built on them. Added `QueueConfig.inflightDir` (lease-dir override) + `prefer(a,b)` dedup tie-break. (b) `inbox.ts` is now a thin wrapper over a single `Queue<WatchTarget>` (`shape:"log"`, `key:path`, `prefer:latest-mtime`, `inflightDir:"inflight"`): `claimInbox`=`claim`, `clearInflight`=`ack`, `restoreInflight`=`restore`, `recoverOrphanInflight`=`recoverAll`. Deleted the hand-rolled rename/read/dedup/restore/recover FS internals (inbox 169→74 lines) + 3 dead `home.ts` path helpers. Dedup-by-latest-mtime preserved via `prefer`. (c) `Refirer implements Source` (`start` no-op, `recover`=`reload`, `stop`); retry/backoff/poison-pill untouched. (d) Daemon boot = `reconcile()` → `recoverAll(sources)` — one loop over `[kick,watch,schedule,refire]` doing `start`+`recover` each, replacing 5 bespoke call sites; SIGHUP left scoped (reconcile + refire reload). Net prod source −45 lines (208 del / 163 ins). Typecheck clean; queue/inbox/refire/refirer/scheduler/watcher/daemon/plugin-run 86 pass (+8 new tests), only pre-existing deno fire-within-3s fail remains (0 new fails) |
