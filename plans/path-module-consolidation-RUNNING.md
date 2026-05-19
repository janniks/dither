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
- [ ] `collection-registry.ts` re-exports `validateCollectionPath` (and exports it as a member).
- [ ] `grants.ts` exists and exports `validateGrantPattern`, `grantsCover`.
- [ ] `collection-paths.ts` deleted.
- [ ] `collection-paths.test.ts` split — validation tests in `collection-registry.test.ts`, grant tests in `grants.test.ts`. Old test file deleted.
- [ ] No `./collection-paths` imports remain.
- [ ] `npm test` and `npm run typecheck` pass.

---

## Phase log

|  |  |
|--|--|
|  |  |
