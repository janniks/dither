# Plan: Option A — pipeline integration test + re-index after promote

> Source: spec given inline by user; closes two correctness gaps left open after phase 2.

## Architectural decisions

- **Re-indexing is host-driven, not search-driven.** `search()` and `get()` assume the qmd index is fresh; they do not call `store.update()`. The host (CLI / future daemon) is responsible for keeping the index current.
- **Trigger points for re-index in v1:**
  - **automatic** — after a successful plugin promote in `runPlugin`.
  - **manual** — `dither index update` subcommand for explicit rebuilds (e.g. after a hand-edit in `~/.dither/entries/`).
- **`updateIndex()` is the single chokepoint.** All re-index paths go through one function. Adds the same value as a daemon-side debounce point later — when the daemon arrives in phase 4, it wraps this function with watchers.
- **Search returns `[]` cleanly when the index/entries dir is missing or empty.** No errors, no implicit indexing. Already true; locking it in with explicit tests.
- **The `dither index` subcommand parent + `update` child** is reserved namespace for future index ops (`dither index status`, `dither index rebuild --full`, etc., all v2+).

---

## Phase 1: Move qmd `update()` out of the search hot path

End-to-end behavior this slice delivers:

- Searching no longer triggers a full index scan on every call.
- A new `updateIndex()` host helper exists and is the single place re-index logic lives.
- A new `dither index update` CLI subcommand lets the user trigger a rebuild manually.
- Existing search/get tests still pass — they now call `updateIndex()` (or an equivalent test helper) after writing fixture markdown.
- Plugin promote still works (just hasn't been hooked to re-index yet — that's phase 2).

**Acceptance:**

- [x] `apps/cli/src/search.ts` no longer calls `store.update()` internally.
- [x] `apps/cli/src/get.ts` no longer calls `store.update()` internally.
- [x] New module exports `updateIndex(): Promise<UpdateSummary>` — opens store, runs `store.update()`, closes/discards. Returns counts (collections / indexed / updated) for visibility.
- [x] New citty subcommand `dither index update` calling that helper, printing the summary.
- [x] All existing tests in `apps/cli/src/` pass without regression — search/get tests call `updateIndex()` after writing fixtures.
- [x] One new test asserts: writing a markdown file under `entries/<col>/` and _not_ calling `updateIndex()` returns no hits from `search()` (proves the auto-update was actually removed).
- [x] One new test asserts: `updateIndex()` against an empty `~/.dither/entries/` returns gracefully (no throw, returns zero counts).
- [x] All gates green: `npm test`, `npm run typecheck`, `npm run lint`, `npm run fmt:check`, `npm run build`.

---

## Phase 2: Hook re-index into promote + full pipeline integration test

End-to-end behavior this slice delivers:

- After `runPlugin` successfully promotes any markdown into `entries/`, the host re-indexes automatically.
- An end-to-end integration test exists that verifies the loop the product is built around: install → run → search → get.
- The test fails before the promote → re-index hook is added, passes after.

**Acceptance:**

- [x] `runPlugin` calls `updateIndex()` after a successful promote when at least one entry was written. Skipped when zero entries promoted (no point in re-indexing).
- [x] New integration test in `apps/cli/src/`:
  - Set `DITHER_HOME` to a temp dir.
  - Install the existing `import-folder` fixture plugin (already in `apps/cli/test/fixtures/`).
  - Run the plugin (no manual `updateIndex()`).
  - Call `search({ query: "fixture", mode: "lex" })` — at least one hit, path includes `imported/`.
  - Call `get({ ref: hit.path })` — content includes the body the fixture writes.
- [x] The test fails if you remove the new `updateIndex()` call from `runPlugin` (proves the test is actually exercising the loop).
- [x] All gates green: `npm test`, `npm run typecheck`, `npm run lint`, `npm run fmt:check`, `npm run build`.
- [x] End-to-end binary smoke against a hand-populated temp `DITHER_HOME` confirms the same loop works through the actual `dither` binary.

---

## Phase log

When starting implementation, this file is renamed to `option-a-pipeline-test-and-reindex-RUNNING.md`. After all phases complete, it's renamed back. No git commits per current convention (user hasn't requested any).

| summary                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 — Moved store.update() out of search.ts / get.ts. New updateIndex() helper in update-index.ts. New `dither index update` subcommand. Tests updated to call updateIndex() after writing fixtures. New tests assert: empty-entries returns zero counts; search without prior updateIndex returns no hits. 20/20 tests pass; all gates green.                                                      |
| Phase 2 — Added updateIndex() call at the tail of runPlugin (skipped if zero promoted). New end-to-end pipeline test in pipeline.test.ts: install → run → search → get, no manual reindex. Verified the test is real by removing the hook (test fails) and re-adding (test passes). 21/21 tests; all gates green; binary smoke confirms install→run→search→get loop through the published `dither` CLI. |
