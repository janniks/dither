# Plan: collection add/remove — take the qmd-index lock

> Source spec: `specs/collection-index-lock-DRAFT.md`

## Architectural decisions

- Helper `reindex(collections?)` lives in update-index.ts next to `updateIndex`; lock-or-marker inside, one unified warn.
- `promotion.ts` / `command-index.ts` untouched.

---

## Phase 1: reindex() helper + both collection call sites + seeded-lock test

**Acceptance:**
- [x] `collection add`/`remove` while `qmd-index` lock held → registration succeeds, `needs-reindex` written, no `updateIndex` runs
- [x] lock free → indexes under the lock as before
- [x] `promotion.ts` and `command-index.ts` diffs empty

---

## Phase log

| 0034abc | Phase 1: reindex() helper, both call sites, seeded-lock test |
|--|--|
| 0034abc | Phase 1: reindex() helper, both call sites, seeded-lock test |
