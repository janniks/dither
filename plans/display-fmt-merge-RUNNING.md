# Plan: display.ts merge into prompt.ts

> Source spec: `specs/display-fmt-merge.md`

## Architectural decisions

- `tildePath` lives in `prompt.ts` alongside other CLI/TUI helpers (AGENTS.md canon).
- `display.ts` is deleted.
- Single vertical slice — one phase.

---

## Phase 1: Move `tildePath` and delete `display.ts`

**User stories**: 1, 2

End-to-end: move the function + test, update 3 import sites, delete the old file. Tests stay green.

**Acceptance:**
- [x] `tildePath` and any tests for it live in `prompt.ts` / `prompt.test.ts`.
- [x] `display.ts` is deleted from the working tree.
- [x] Three call sites (`commands/init.ts`, `commands/status.ts`, `qmd-download-render.ts`) import from `./prompt`.
- [x] `npm test` and `npm run typecheck` pass from `packages/cli`.

---

## Phase log

|  |  |
|--|--|
|  |  |
