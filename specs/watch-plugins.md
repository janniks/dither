# spec — watch plugins (DRAFT)

> Scope: collection-watch semantics, path resolution, SDK interface for
> watch fires, backfill mode, and queue/rate-limit story.
> Triggered by: url-scraper switching off the `SOURCE` file grant.

## Decisions (locked)

### 1. Unified `watch` trigger
- One manifest block: `watch: { collections: [...], glob? }`.
- One trigger value: `"watch"`.
- No separate "collection-watch" type.

### 2. Path resolution in `watch.collections`
Each entry is one of:
- `"github"` → `<library>/github` (collection).
- `"github/repositories"` → `<library>/github/repositories` (subfolder of collection).
- `"./foo"` → `<library>/foo` (library-relative, explicit).
- `"/abs/path"` → `/abs/path` (raw absolute).

Already implemented in `watcher.ts`. Backfill CLI uses the same resolver.

### 3. Persistence model — inbox + inflight + state
Three files per plugin, three roles, no overlap:

- **Inbox** (`~/.config/dither/inboxes/<plugin>.ndjson`, host-owned).
  Pure append-only NDJSON. Host writes one row per chokidar event:
  `{"path": "/abs/path.md", "mtime": "2026-05-13T12:34:56.789Z"}`.
  Duplicate paths are allowed in the file; dedup happens at claim time.

- **Inflight** (`~/.config/dither/inflight/<plugin>.ndjson`, host-owned).
  Set at fire start: host reads inbox, dedupes by path (keep latest
  mtime), writes the deduped set to inflight, then truncates inbox —
  atomic via temp-file + rename. Cleared at clean-exit-without-reschedule.
  On non-zero exit or signal kill, inflight rows are *appended* back to
  inbox (no prepend, no order preservation — plugin uses `mtime` as
  cursor). If a path was re-touched during the run, the newer mtime wins
  at the next claim's dedup pass.

- **state.json** (plugin-owned, existing). Plugin tracks what it has
  *finished* — checkpointed every N items. Cursor concept = "highest
  mtime fully processed" + done-paths set for the current mtime tier.

### 4. Targets shape
Plugin receives, in `input.targets`:
```ts
type WatchTarget = { path: string; mtime: string }; // ISO-8601 UTC
```
mtime enables: cursor-as-value (resume after refire), staleness detection
(same path reappears with newer mtime → re-process), and natural ordering
for chunked plugins.

### 5. Fire lifecycle
1. Host appends watch events to inbox (with mtime from `stat`).
2. When plugin isn't running, host atomically moves inbox → inflight and
   fires plugin with `input.targets = inflight contents`.
3. Plugin processes targets, checkpointing state.json frequently.
4. Plugin exits.
5. Host inspects: clean exit (0) + no reschedule → delete inflight;
   clean exit (0) + reschedule sent → keep inflight, schedule refire at
   requested time; non-zero exit / signal → return inflight to inbox.
6. If inbox still non-empty after a clean run → host fires plugin again
   immediately (drain loop).

### 6. SDK additions
- `input.targets: WatchTarget[]` (was `string[]`).
- New control message via existing stderr NDJSON channel:
  `{ "_dither": "reschedule", "afterMs": 300000 }`.
  Plugin emits then exits 0. Host treats inflight as preserved + schedules
  a refire after `afterMs`.

### 7. Backfill
`d plugin run <name> --backfill` walks every path under the plugin's
`watch.collections`, captures `(path, mtime)`, appends to inbox, signals
the daemon to drain. Same fire pipeline as a watch event. No special
"backfill mode" inside the plugin.

### 8. Poison-pill guard
Host keeps a consecutive-non-clean-exit counter per plugin. After 3 in a
row, auto-refire stops; inflight stays on disk; daemon log surfaces the
plugin name. User runs `d plugin run <name>` manually to retry — a clean
run clears the counter.

### 9. Lock + debouncer
- Existing per-plugin `acquireLock` keeps single-instance.
- Chokidar debouncer raised from 5s window / 30s cap to **30s window /
  5min cap**. With the inbox + drain-loop, debouncing is no longer
  load-bearing for correctness — it just reduces plugin spawn churn
  during bursts (e.g. a large import dropping thousands of files). The
  longer cap is safe because the inbox persists events; users see a
  small first-fire latency in exchange for far fewer Deno spawns.

## User stories

1. As a user, I want a watch plugin to react when entries land in a
   collection I care about, so that new data gets processed without me
   running anything.
2. As a user, I want `d plugin run <name> --backfill` to feed my whole
   library through a newly-installed watch plugin, so I don't have to
   wait for organic changes to seed it.
3. As a user, I want watch fires to survive a daemon crash or laptop
   reboot mid-run, so I don't silently lose changes during downtime.
4. As a user, I want a long-running plugin to checkpoint progress, so a
   crash 30 % through 10 k entries doesn't restart from zero.
5. As a user, I want a rate-limited plugin to ask the host for a refire
   later (e.g. 5 min) rather than block in-process for hours.
6. As a user, I want a plugin that keeps crashing to stop auto-firing
   after a few attempts, so I see the failure instead of a tight refire
   loop in my logs.
7. As a plugin author, I want `input.targets` to include each target's
   mtime, so I can detect re-changes between fires and use mtime as a
   cursor.
8. As a plugin author, I want one `watch.collections` form that accepts
   bare names, library-relative paths, and absolute paths, so I don't
   need a different manifest depending on where my source lives.
9. As a plugin author, I want a single SDK call (`reschedule(afterMs)`)
   to defer remaining work, so I don't have to reimplement deferred
   execution in every plugin.
10. As an operator (the user's daemon admin hat), I want inbox/inflight
    state I can `cat` to see what's pending or stuck, so debugging is
    grepping a file, not attaching a debugger.

## Module sketch (deep modules to extract)

- **Inbox/inflight store** — file ops only: `append`, `peek`, `claim`
  (inbox → inflight), `restore` (inflight → inbox), `clear`. Testable
  with a tmpdir; no daemon, no chokidar, no plugin process. Used by the
  watcher, the runner, and the backfill CLI.
- **Watch path resolver** — `resolveWatchPath(root, entry)` already
  prototyped in `watcher.ts`; promote to its own file and reuse from
  the backfill CLI (currently a duplicate copy in `commands/plugin.ts`).
- **Refire scheduler** — one row per plugin with `{ plugin, fireAt,
  reason: "reschedule" | "drain" | "poison-backoff", retryCount }`.
  Tiny; piggybacks on existing daemon scheduler.
- **Run-result interpreter** — given exit code + control messages,
  decides: clear inflight / restore inflight / schedule refire /
  increment poison counter. Pure function over `{ exitCode, signals,
  controlMessages }`. The branching logic from §5 lives here, not
  scattered.

## Testing decisions

- **Inbox/inflight store**: unit tests over tmpdir. Cover append-dedup
  (latest mtime wins), claim atomicity, restore-on-failure, clear.
- **Watch path resolver**: pure function, table-driven tests.
- **Run-result interpreter**: pure function, table-driven tests over
  every `(exit, signal, has-reschedule)` combination.
- **End-to-end**: one integration test that fires a synthetic plugin
  through the watcher + inbox + runner pipeline (no chokidar — call the
  inbox writer directly), asserts inflight lifecycle.
- No mocks for fs — use tmpdir per AGENTS.md.

## Out of scope

- Multi-instance plugin runs (still single-instance per plugin name).
- Distributed / multi-host: the inbox is local-only.
- Cross-plugin work queues (no shared queue between plugins).
- Replacing the chokidar debouncer.
- Migrating other watch plugins (this spec covers the mechanism; each
  plugin migrates on its own plan).
- A stateless-watch-plugin path (every watch plugin must keep state.json).

## Further notes

- The url-scraper migration is a separate plan, scoped to: switch
  manifest to `watch`, add adoption-on-fire-start (write inbox targets
  into its own pending queue in state.json before any fetch), wire up
  `reschedule()` for HTTP 429 / connection errors. The scraper already
  has the per-URL cache that makes it idempotent — perfect fit for the
  at-least-once delivery model.
- `mtime` as ISO-8601 is the debuggable choice; can switch to Unix ms
  later without breaking the SDK type if we keep the field name `mtime`
  and bump the SDK major. Not now.
