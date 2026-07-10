# Fire choke point — stop dropping busy kicks; drop the threading; keep it in daemon.ts

Source: architecture review 2026-07-10 + intent check + deep trace.
Verdict: keep the choke point where it is (CLAUDE.md documents it; the reconcile spec relies on it seeing every run end). No standalone module.

## Problem

- Dropped kick. A kick that finds the plugin lock held returns `true` (`daemon.ts:177-180`); `fireKick` maps `true → "done"` (`daemon.ts:233`); the queue acks and deletes it. The run never happens.
- The CLI hangs, not just loses the kick. `plugin run X` writes the kick, then tails the pre-assigned `runId` via `tailRun`/`followRun` (`command-plugin-run.ts:399`, `:186`). If the kick is dropped, that journal never appears — `followRun` polls until Ctrl-C. (The CLI's `hasKick || isLockHeld` pre-check at `:357` catches most cases; the gap is the race between that check and the daemon claiming the kick.)
- Threading. `fireWithSuppress` takes 8 positional params; `fireWatch`, `fireScheduled`, `fireKick`, and the recursive watch-drain each re-thread the same `(state, watcher, refirer, detector, notify)`. Exported "for tests only."
- Swallowed error. `readRefire(name).catch(() => null)` (`daemon.ts:202`) hides real I/O errors — `readRefire` already returns null for ENOENT and throws for real errors (`refire.ts:42-50`), so any EACCES/partial-write drops the refire row and the plugin silently stops re-firing.

## Solution

- Busy kick → restore, don't ack. Lock-held returns the queue's existing `"retry"` (not `true`/`"done"`), so the kick stays pending. The pre-assigned `runId` is preserved, so when it re-fires the journal appears at `history/<runId>/` and the CLI tail resolves. Do NOT convert to a refire row: the refirer fires `trigger=watch` with a fresh `runId` and no overrides — the tail would hang and overrides vanish.
- Re-drain when the lock frees. Extend the post-run hook the reconcile spec adds (fired after `releaseLock`): widen from `() => void` to `(name) => void`; alongside the reindex-marker check it re-drains pending kicks (`void kicks.drain().catch(log)` — a cheap readdir, usually empty; drains all pending kicks — firing an unrelated one slightly early is harmless, it goes through the same choke point). Bounded: a kick that can't get the lock never runs, so it spawns no post-run of its own — no loop.
- Bind collaborators once. `makeFire(state, {watcher, refirer, detector, notify, postRun})` returning `fire(name, trigger, kick?)`, local to daemon.ts. Delete `fireKick`; the busy→`"retry"` mapping is just `fire`'s return. `fireWatch`/`fireScheduled`/kick-source/recursive-drain all call the 3-arg `fire`. Tests build `fire` via `makeFire` — no internals export.
- Fix the read. `daemon.ts:202`: `.catch(() => null)` → log the error, return null — surfaces the failure, still lets the fire finish, and keeps the `void`-fired recursive drain from unhandled rejections.

## Constraints

- Choke point stays in daemon.ts as the one per-fire convergence: handingOff gate → loop detector → runPlugin → suppressOnce → refire pickup → postRun.
- Sequencing with `specs/reconcile-on-deferred-reindex.md`: both specs use ONE post-run hook, signature `(name) => void`. Whichever lands first defines it; reconcile ignores `name`, kicks use it. Do not invent two hooks.
- Kicks keep firing `trigger=watch` for backfill; regression tests from 7dd0935 / 44db3cd stay green (`plugin-host.test.ts`, untouched).
- Scheduler / Watcher / Refirer unchanged.

## LOC

- `daemon.ts`: delete `fireKick` (~21); `makeFire` kills re-threading at 4 call sites → net ~ −25.
- Read fix +1; post-run kick re-drain +3 (shared with reconcile). Tests rebuilt on `makeFire`, ~flat. Net ~ −20.

## Acceptance

- [ ] kick arriving while the plugin lock is held is not dropped — re-fires with its original `runId` once the lock frees (test)
- [ ] CLI foreground `plugin run` on a busy plugin streams to completion instead of hanging
- [ ] `fire` called with ≤3 args everywhere; no "export for tests only"
- [ ] refire pickup read error is logged, not silently nulled
- [ ] backfill `trigger=watch` regression tests unchanged and green
- [ ] post-run kick re-drain terminates when a run completes with no pending kick
