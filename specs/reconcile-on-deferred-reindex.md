# reconcile-on-deferred-reindex

## Problem

- `needs-reindex` marker can strand: written while no reconcile cycle is inflight → nothing consumes it until next SIGHUP or daemon restart.
- Observed 2026-07-04: imessage + safari-history fired at :00, promotes raced for the index lock, loser deferred (`promotion.ts:143` `requestReindex()`), marker sat ~6h.
- Effect: deferred catch-up indexing + embed backlog wait indefinitely. No data loss — files are on disk; only the rescan is stranded.
- CLAUDE.md already documents the *intended* behavior ("daemon coalesces this into its next post-job reconciliation") — the post-job hook does not exist.

## Marker writers, audited

- `promotion.ts:143` — defer when index lock busy. **Uncovered** when the lock holder is another plugin run's inline `updateIndex` (not a reconcile child). ← the bug.
- `command-index.ts:53` — `dither index update` while daemon mid-index → reconcile child is inflight; its post-cycle self-refire (`daemon.ts:526`) sees the marker. Covered.
- `command-index.ts:79` — marker + SIGHUP. Covered.
- Post-cycle refire (`daemon.ts:526`) — covers markers written *during* a cycle. Covered.

## Fix

One new seam, mirroring `notify`: after every plugin run completes, the daemon checks for the marker and coalesces a reconcile.

- `daemon.ts:fireWithSuppress`: accept one more callback param (`sweep: () => void`, name TBD at impl), call it once after the `finally` (post `releaseLock`), before the refire pickup. Unconditional call — the check lives daemon-side.
- `runDaemon`: declare `let sweep: () => void = () => undefined;` next to the `writeStatus` no-op (same late-bind pattern — the fire closures are built before `fireQmdReconcile` exists). After `fireQmdReconcile` is defined, rebind:
  `sweep = () => { if (existsSync(needsReindexPath())) fireQmdReconcile(); };`
- Thread `sweep` through `fireWatch` / `fireScheduled` / `fireKick` call sites, same as `writeStatus`.

## Why this closes it

- The deferring run's *own* post-run sweep sees the marker it just wrote (promote runs inside `runPlugin`, before the sweep). No dependency on a subsequent run.
- The lock-holder run's sweep also sees it — whichever finishes last wins; `fireQmdReconcile` coalesces (inflight + queued, 500ms refire floor), so double-fire is safe and cheap.
- Marker written while a cycle is inflight → existing post-cycle refire. Marker written while idle → new sweep. No gap left; no periodic polling introduced (design stays event-driven).

## Non-goals

- No fs.watch on `markers/` (extra fd + a whole watcher for one file; the choke point already sees every run end).
- No change to `promotion.ts` or the marker protocol.
- No status-snapshot change; sweep is not `notify`.

## Acceptance

- [ ] Run completes while marker exists + no cycle inflight → reconcile child spawns without SIGHUP/restart.
- [ ] Two concurrent runs race the index lock → loser's marker consumed after runs settle.
- [ ] No marker, run completes → no reconcile spawned (sweep is a cheap existsSync).
- [ ] Existing coalescing behavior unchanged (one child at a time, queued follow-up, 500ms floor).
- [ ] Test: fireWithSuppress invokes sweep exactly once per fire, after lock release.
