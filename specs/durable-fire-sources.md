# Spec: Durable fire sources

> The daemon is a thin supervisor of concurrent child processes, coordinated
> by per-identity locks — not a shared loop.

## Problem

Fire sources have mix-and-match durability:

- **Kicks**, **refires** — durable (files), replayed on boot. ✅
- **Watcher** — inbox is durable + at-least-once, but file changes *during the
  down-window* are never seen (no boot catch-up). ⚠️
- **Scheduler** — pure in-memory croner; a tick due while the daemon is down is
  **silently dropped** (no persisted `lastRun`, no catch-up). ❌

This bites on every crash/restart, and once version-restart ([[daemon-restart-latest]])
makes restarts routine, the gap is constant. We want **one pattern** — a durable
queue + reconcile-on-boot — so nothing is lost across a restart, with durability
in one deep module instead of scattered across `inbox`/`kicks`/`refire`/`scheduler`.

## Stories

- As the daemon, on boot I replay every source's owed work from durable state —
  no scheduled tick or watch event is lost because I was down.
- As a plugin run, I commit output **and** state atomically, or roll back
  entirely — an interrupted run leaves no trace.
- As a maintainer, every source shares one durable-queue abstraction.

## Decisions

### The deep module — one durable, per-identity queue

- `Queue<T>` per plugin. Tiny interface: `enqueue(item)` (durable, dedup'd) +
  `drain(run)` (claim → run → `ack` | `restore`). It **hides** atomic
  tmp+rename, storage shape, dedup, the inflight lease, ack/restore, and boot
  recovery. `inbox`+`inflight`, `kicks`, `refire` durability collapse into it.
- **Filesystem substrate**, not SQLite (cross-process child workers can't share
  a DB handle; effects are FS — see [[queue-patterns-survey]]). One file per
  identity; atomic tmp+rename; `readdir`/ENOENT→[].
- **Try this abstraction; review after implementation** (final phase) to see how
  it actually landed. Depth belongs in the Queue — see the caution below.

### Thin sources — adapters, kept distinct

- `Source`: `start(emit)` (live) + `recover(emit)` (boot: re-derive owed work) +
  `stop()`. Mirrors today's identical `set`/`stop`/`stats` shapes.
- **Do NOT unify cron + chokidar + kicks into one config-bag** — that's a
  shallow, leaky over-abstraction. Sources stay small and distinct; the *Queue*
  is deep, the sources are dumb adapters.

| Source | `start` (live) | `recover` (boot) |
|---|---|---|
| Watcher | chokidar change → emit | **mtime watermark scan** (per watched collection) |
| Scheduler | cron tick → emit | persisted **`lastRun`** → anacron catch-up (missed tick fires once; N missed → 1) |
| Refirer | timer-per-row → emit | re-arm rows *(already durable)* |
| Kicks | SIGUSR1 → emit | `scanKicks` *(already durable)* |

Inflight is **not** a source — it's the Queue's own recovery.

### Delivery guarantee

- **At-least-once delivery + transactional/idempotent processing = exactly-once
  *effect*** — the universal pattern across SQS/Kafka/RabbitMQ/Sidekiq/Temporal
  ([[queue-patterns-survey]]).
- Claim = a **lease, not a delete**: ack on success, restore on failure, boot
  recovery re-queues unacked. (Today's inflight model, generalized.)
- **No live-lease/sweep, no timers** — boot recovery only ([[daemon-restart-followups]]).

### Plugin run = transaction

- Stage `state.json` in `runs/<runId>/` (seeded from committed
  `<pluginDir>/state/state.json`); point `DITHER_STATE_FILE` there; grant write
  to `runDir` only (tightens the sandbox).
- On clean finish, commit state atomically (tmp+rename) **alongside** promotion.
  On interruption/crash, `runs/<runId>/` is discarded → output **and** state roll
  back together.
- The reconcile child stays idempotent (SQLite + qmd lock) — exactly-once-effect
  by nature.

### Consumer (shape unchanged)

- One choke point: `fireWithSuppress`. Per-plugin lock = single-active-per-key
  (one run per plugin); different plugins run concurrently. No global concurrency
  cap (deferred — [[daemon-restart-followups]]).

## Review (P6)

The deliberate "try it, then look at how it landed" pass. Verdict: **deep
module landed**; the only interface correction needed was dropping the
vestigial `start` emit.

- **The Queue is a genuine deep module.** Small surface
  (`enqueue`/`claim`/`ack`/`restore`/`drain`/`recover`/`recoverAll`/
  `pendingNames`), all durability hidden behind it (atomic tmp+rename, the two
  storage shapes, dedup, the inflight lease). Five-plus consumers share the one
  implementation: kicks, the inbox, and the per-source recover paths. `inbox.ts`
  collapsed 169 → 74 lines (a thin wrapper over a single `Queue<WatchTarget>`),
  and daemon boot reduced to one `recoverAll` loop over the source list,
  replacing five bespoke recovery call sites.
- **`Source` is a thin, honest contract.** After review, `start`'s `emit`
  parameter was dropped — kicks, watcher, scheduler, and refirer all ignore it;
  each fires through its own closure (the SIGUSR1 drain, the chokidar/cron
  callback, the refire timer). Only `recover(emit)` actually emits. The contract
  is now `start()` + `recover(emit)` + `stop()`, describing exactly what's used.
  Sources stayed distinct adapters — no cron/chokidar/kick mega-union — so depth
  lives in the Queue, as intended.
- **Deliberate divergences kept** (decisions, not accidents):
  - `QueueConfig.prefer` (latest-mtime dedup tie-break) and
    `QueueConfig.inflightDir` (the inbox's historical `<home>/inflight/`
    layout) exist solely for the inbox's second storage shape. They're the
    minimum needed and documented at the config; not removed.
  - **SIGHUP stays the lighter `reconcile + refire reload`**, not the full
    `recoverAll`. Routing reload through `recoverAll` would re-fire owed work
    (re-drain kicks, re-scan the watch watermark, re-run the schedule anacron
    catch-up) on every config reload. Boot is the single uniform `recover all`;
    reload is intentionally scoped.
  - `kickSource` returns `Source & { drain() }`; `drain()` is a **test-only
    seam** (the daemon drives kicks through `start`/`recover`/`stop`), commented
    as such rather than promoted into the interface.

## Non-goals / deferred

See [[daemon-restart-followups]]: live lease + sweep, global concurrency cap,
watch/scheduler staleness checks, per-plugin exactly-once dedup-key. Moving the
queue to SQLite is rejected ([[queue-patterns-survey]]).
