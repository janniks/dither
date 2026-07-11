# Collection add/remove — take the qmd-index lock

Source: architecture review 2026-07-10 + intent check.
Scope cut hard by intent: `command-index.ts`'s inline-index-then-marker+SIGHUP is deliberate race catch-up (commented as such) — leave it. `specs/reconcile-on-deferred-reindex.md` non-goals "no change to promotion.ts or the marker protocol" — don't fight it. The missing lock in `command-collection.ts` is the one real defect; this spec is that fix only.

## Problem

- `command-collection.ts:35` (add) and `:100` (remove) call `updateIndex()` with no `qmd-index` lock. If the daemon is mid-index, both write the same SQLite store at once.
- `command-index.ts` and `promotion.ts` already guard `updateIndex` with `acquireTheme("index")`. The two collection sites are the only unguarded callers.

## Solution

- Add one helper in `update-index.ts` — `reindex(collections?)` — wrapping `updateIndex` with the lock:
  - `acquireTheme("index")`.
  - Lock busy → `requestReindexSync()` + the same busy message `command-index.ts:49-52` uses, then return. The daemon's next reconcile catches up (composes with the deferred-reindex sweep).
  - Lock free → `updateIndex(collections)` in try/finally, release on exit. A thrown rescan is warned (one unified message), not rethrown — the caller already saved config.
- Both collection sites drop their own try/catch and call the helper (add: `await reindex([entry.name])`; remove: `await reindex()`).
- Unlike `index update`, collection add/remove still succeed on a busy lock (config is already saved) — they print `registered`/`unregistered` and exit 0. Only the rescan is deferred, never the registration.

## Why a helper (not inline)

- Used twice; both sites collapse from ~12 lines to ~4, deleting the duplicated try/catch-warn. Net product LOC ~flat; one duplicated pattern removed; the missing lock added.
- `promotion.ts` keeps its own inline version on purpose (it journals `reindex-deferred` instead of printing) — it does not use the helper.

## Constraints

- `promotion.ts` and `command-index.ts` diffs stay empty.
- Marker protocol unchanged — reuse `requestReindexSync` / `needsReindexPath`.
- No `fs.watch` on `markers/`; the deferred marker is drained by the existing sweep from `reconcile-on-deferred-reindex`.
- `updateIndex` stays exported (promotion + command-index still call it).

## LOC

- `update-index.ts`: +~18 (helper + imports). `command-collection.ts`: −~16. Test: +~15.

## Test (command-collection.test.ts)

- Mirror the `command-index.test.ts` busy case: seed a live-held lock via `writeFileSync(themeLockPath("index"), String(process.pid))`, run `collection add`.
- Assert: collection saved in config, `needsReindexPath()` exists, busy message printed, no throw.

## Acceptance

- [ ] `collection add`/`remove` while `qmd-index` lock held → registration still succeeds, `needs-reindex` written, no `updateIndex` runs (seeded-lock test)
- [ ] with lock free → indexes under the lock as before
- [ ] `promotion.ts` and `command-index.ts` diffs are empty
