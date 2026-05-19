# Plan: Path module consolidation

> Source spec: `specs/path-module-consolidation.md`

## Architectural decisions

- `paths.ts` content moves into `config.ts` as POJO + free functions.
- `collection-paths.ts` splits along concern lines:
  - `validateCollectionPath` (+ internal segment validators) → into `collection-registry.ts`.
  - `validateGrantPattern`, `grantsCover` → new `grants.ts`.
- `home.ts` untouched.

---

## Phase 1: Fold `paths.ts` into `config.ts`

**User stories**: 1, 2, 5

End-to-end: same four functions (`libraryRoot`, `collectionDir`, plus their *FromConfig variants), new home. Import paths update across callers.

**Acceptance:**
- [x] `paths.ts` is deleted.
- [x] `config.ts` exports `libraryRoot`, `collectionDir`, `libraryRootFromConfig`, `collectionDirFromConfig`.
- [x] No `./paths` imports remain.
- [x] `npm test` and `npm run typecheck` pass.

---

## Phase 2: Split `collection-paths.ts` into `collection-registry.ts` + `grants.ts`

**User stories**: 3, 4, 5

End-to-end: validation moves to identity owner; grant helpers get their own module; old file deleted. Tests split along the same lines.

**Acceptance:**
- [x] `collection-registry.ts` exports `validateCollectionPath` (and `validateCollectionPathSegment` for grants.ts to reuse).
- [x] `grants.ts` exists and exports `validateGrantPattern`, `grantsCover`.
- [x] `collection-paths.ts` deleted.
- [x] No dedicated `collection-paths.test.ts` existed; existing integration tests in plugin-install/-interactive/-run cover the split functions.
- [x] No `./collection-paths` imports remain.
- [x] `npm test` and `npm run typecheck` pass.

---

## Phase log

| commit | summary |
|--|--|
| 2e65dba | Phase 1 — paths.ts folded into config.ts; 3 callers updated; deletes 1 module |
| <next> | Phase 2 — collection-paths.ts split into collection-registry.ts (validation) + grants.ts (grant patterns/coverage); 3 callers updated; 372 tests pass |
