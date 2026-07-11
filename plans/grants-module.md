# Plan: grants file — one type, one reader, one path helper

> Source spec: `specs/grants-module-DRAFT.md`

## Architectural decisions

- File layer lives in existing `grants.ts` (one grants module). `Grants` type = exact on-disk shape.
- `readGrants` returns the parsed object (unknown fields preserved for read-modify-write), normalizing `create/edit/net → []`, `name` defaulted from filename.
- `listGrants()` returns full `Grants[]`.
- `printInstallHint` / `ensureDaemonForPlugin` go async-read (both callers already async).

---

## Phase 1: grants.ts file layer + grantsPath + all readers converted

**Acceptance:**
- [x] one `Grants` type; zero private re-declarations or inline grant shapes
- [x] `grantsPath` in home.ts; no hand-built grants paths remain
- [x] `plugin-list.ts` deleted; daemon/status/list-cmd consume `listGrants()`
- [x] legacy null/absent-schedule + absent-watch tested once in `grants.test.ts`
- [x] `configurePlugin` read-modify-write preserves untouched fields

---

## Phase log

|  |  |
|--|--|
|  |  |
