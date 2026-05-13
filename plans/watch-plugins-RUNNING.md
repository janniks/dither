# Plan: Watch plugins — inbox/inflight + mtime + reschedule

> Source spec: `specs/watch-plugins.md`

## Architectural decisions

- **Manifest**: unchanged shape (`watch: { collections: [...], glob? }`). Path
  resolution rules from spec §2 (bare / `./` / `/`) already prototyped in
  `watcher.ts`; promoted to a shared module in Phase 3.
- **Persistent state**:
  - `~/.config/dither/inboxes/<plugin>.ndjson` — host-owned, append-only.
    Rows: `{"path": "...", "mtime": "<iso>"}`.
  - `~/.config/dither/inflight/<plugin>.ndjson` — host-owned, written
    atomically at fire start, cleared on clean exit, restored to inbox on
    failure. Phase 2.
  - `~/.config/dither/refires/<plugin>.json` — host-owned, one row with
    `{fireAt, retryCount}`. Phase 4.
  - `state.json` — plugin-owned, unchanged location/contract.
- **SDK contract**:
  - `input.targets: WatchTarget[]` where `WatchTarget = { path, mtime }`.
    Replaces `string[]`. Breaking change — no compat shim.
  - New control message via existing stderr NDJSON channel:
    `{_dither: "reschedule", afterMs: N}`. Phase 4.
- **Fire lifecycle**: chokidar event → append inbox → debounce timer
  (30s window / 5min cap) → fire → drain inbox → run plugin → on exit,
  handle inflight per result-interpreter. Drain-loop on completion.
- **Debounce parameters**: bumped from 5s/30s to 30s/5min.
- **Trigger semantics**: single `trigger: "watch"` for organic and
  backfill-seeded fires. Manual `d plugin run <name>` without `--backfill`
  still fires once with whatever's in inbox.

---

## Phase 1: Inbox-backed fires with mtime targets

**User stories**: 1, 7, 8

Replace the watcher's in-memory pending-targets buffer with a per-plugin
inbox NDJSON. Each chokidar event becomes one inbox row, captured with
its mtime (via `alwaysStat: true`). Runner reads + truncates inbox at
fire start; passes parsed rows as `input.targets` (new shape). Drain
loop kicks in if inbox is non-empty after a run. Debouncer bumped.

Known gap this phase: a crash mid-run loses items (no inflight yet).
Acceptable — Phase 2 closes it.

**Acceptance:**
- [x] Inbox file appears at `<home>/inboxes/<plugin>.ndjson` after first
      chokidar event.
- [x] Each row is valid JSON with `path` and ISO-8601 `mtime`.
- [x] Plugin SDK type for `input.targets` is `WatchTarget[]`; existing
      `string[]` callsites updated.
- [x] `url-scraper-test` consumes the new shape (iterates `target.path`).
- [x] After a fire, inbox file is empty.
- [x] Editing two files in the same watched collection within the
      debounce window produces one fire with both targets.
- [x] Debouncer constants are 30000 / 300000.
- [x] Existing watcher tests / cli tests still pass.

---

## Phase 2: Inflight + at-least-once + daemon recovery

**User stories**: 3, 4

Atomic claim at fire start: read inbox → write to `<home>/inflight/<plugin>.ndjson`
→ truncate inbox, all under a temp-file + rename dance. Pass inflight
contents as `input.targets`. On clean exit (code 0, no reschedule yet —
Phase 4): delete inflight. On non-zero exit / signal kill: append
inflight rows back to inbox, delete inflight. On daemon startup: scan
inflight dir, restore any orphans to inbox.

**Acceptance:**
- [x] Inflight file exists during a run, absent after a clean run.
- [x] Kill plugin mid-run (e.g. `SIGKILL`); inflight items are restored
      to inbox; next fire picks them up. (Covered by `restoreInflight`
      unit test simulating non-clean exit.)
- [x] Re-changing a path while it's inflight is preserved as the newer
      mtime at the next claim's dedup pass.
- [x] Daemon restart with an orphan inflight file recovers the items
      into inbox at startup. (`recoverOrphanInflight` unit test +
      daemon startup wiring.)
- [~] No item loss across an artificial daemon crash test
      (`kill -9 <daemon-pid>` mid-fire → restart → all targets observed).
      Deferred as an e2e; the constituent operations are unit-tested.

---

## Phase 3: Backfill seeds inbox

**User stories**: 2

`d plugin run <name> --backfill` walks every path under the plugin's
`watch.collections` (using the resolver from §2 promoted to its own
module + reused from the watcher), captures `(path, mtime)`, appends to
inbox, then either signals the daemon to drain or runs in-process if
the daemon isn't up. No special "backfill mode" code path inside the
plugin — same fire pipeline as a watch event.

**Acceptance:**
- [x] Watch-path resolver lives in one module; watcher + backfill both
      import it. (`watch-paths.ts` + table-driven tests.)
- [x] `d plugin run url-scraper-test --backfill` against a small fixture
      seeds inbox with one row per `.md` file under the watched
      collections.
- [x] Backfill against a collection containing no `.md` files exits
      cleanly with an explanatory message (not a crash).
- [~] Daemon-running case: backfill seeds inbox; the local run then
      tries to acquire the plugin lock and drains. If the daemon is
      mid-fire, the lock conflict surfaces a clear error and the
      seeded items remain queued — daemon will pick them up on its
      next fire. (Pure "seed and exit, let daemon drain anything" is
      a phase-4 polish: the refire scheduler lets us signal the
      daemon without a chokidar event.)
- [x] Daemon-not-running case: backfill triggers a one-shot
      foreground run that drains the inbox.
- [x] `--backfill` errors out cleanly on a plugin without
      `watch.collections`.

---

## Phase 4: Reschedule + refire scheduler + poison-pill

**User stories**: 5, 6

New stderr NDJSON control message: `{_dither: "reschedule", afterMs: N}`.
Host parses, writes a refire row `{fireAt, retryCount}` to
`<home>/refires/<plugin>.json`. Daemon scheduler picks it up at `fireAt`
and triggers a fire. Consecutive-non-clean-exit counter per plugin;
after 3 → suspend auto-refire (refires file gets a `suspended: true`
flag), surface in `d status`. A successful manual run clears the counter.

A small synthetic plugin (`test.local/plugins/refire-probe/`) covers
both paths: rate-limit path (calls `reschedule` once, completes on
second fire) and crash-loop path (exits non-zero deterministically).

**Acceptance:**
- [ ] `reschedule({afterMs})` SDK helper emits the NDJSON line.
- [ ] Host parses + persists refire row; daemon fires at `fireAt`.
- [ ] Clean exit with reschedule → inflight preserved + refire scheduled.
- [ ] 3 consecutive non-clean exits → auto-refire suspended; `d status`
      shows the plugin in a `suspended` state.
- [ ] Manual `d plugin run <name>` with a successful exit clears the
      counter.
- [ ] Refire row survives daemon restart.

---

## Phase 5: Scraper migration to the new contract

**User stories**: 9 + closes the loop on the original ask

The url-scraper graduates onto the durable pipeline. First action of
every fire: merge `input.targets` into a pending-queue inside its
`state.json` (`{pending: WatchTarget[], cursor: { mtime, donePaths }}`).
Process from the pending-queue, checkpointing after each URL write.
Switch to per-request error handling that calls `reschedule(5*60_000)`
on HTTP 429 / connection failure (matching the host's at-least-once
semantics — the URL stays in pending across the wait).

Drops the in-process sequential pacing assumption: a fire may process N
targets and exit early via `reschedule`, with the host handling the
delay rather than `setTimeout` blocking the run.

**Acceptance:**
- [ ] Scraper's first action on every fire is the
      adopt-targets-into-state write.
- [ ] Crash mid-fire (post-adopt) loses no work — next fire reads
      pending from state.json and resumes.
- [ ] HTTP 429 from a scraped URL produces a `reschedule` call; the
      target remains in pending across the refire.
- [ ] `d plugin run url-scraper-test --backfill` against
      `~/.dither/library/twitter` produces scraped entries under
      `urls/<host>/` and survives an interrupted run.
- [ ] All existing scraper tests (`extract.test.ts`, `render.test.ts`)
      still pass.

---

## Phase log

When starting implementation, this file is already renamed
`watch-plugins-RUNNING.md`. Work one phase at a time, ticking each
phase's acceptance criteria as you satisfy them. Stage and commit each
phase's changes after finishing, then continue to the next phase on
your own. Append a row to the log below after every phase. When all
phases complete, rename back to `./plans/watch-plugins.md`.

| commit | summary |
|--------|---------|
| 891d0ef | Phase 1: inbox-backed fires with mtime targets. Watcher writes NDJSON on every chokidar event; runner claims inbox at fire start; SDK `targets` shape now `{path, mtime}[]`; drain loop after each fire; debounce bumped to 30s/5min. |
| 4f40f8f | Phase 2: inflight + at-least-once + daemon recovery. claimInbox writes inflight before truncating inbox; clearInflight on clean run; restoreInflight on any failure; daemon startup runs recoverOrphanInflight. 6 unit tests. |
