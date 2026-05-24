# Plan: cli table output

> Source spec: `specs/cli-table-output.md`

## Architectural decisions

- **Helper location**: `packages/cli/src/table.ts` — self-contained,
  no imports from `prompt.ts` so it stays deep-importable. `prompt.ts`
  re-exports `printTable` + `ColOpt` so commands keep a single TUI
  import surface (`./prompt`). Tests import directly from `./table`.
- **API shape**: `printTable(rows: string[][], cols?: ColOpt[])`. Per-column
  `align`, `min`, `max`, `color`. Color applied after padding.
- **TTY vs pipe**: TTY → padded + colored. Non-TTY → tab-separated raw.
- **Last column**: truncates to remaining terminal width via `fitOneLine`
  (already in `prompt.ts`). Other columns clamp by `max`.
- **Times**: `formatRelPast(ms)` in `relative-time.ts`. Single-unit except
  `<5m` shows two units (see spec).
- **No new runtime dep.**

---

## Phase 1: helper + reltime

**User stories**: foundation for everything below.

Add `table.ts` with `printTable`. Add `formatRelPast` next to
`formatRelTime`. Pure functions, table-driven tests.

**Acceptance:**
- [ ] `packages/cli/src/table.ts` exports `printTable` and a `ColOpt` type
- [ ] `table.ts` has no import from `prompt.ts` (so it remains deep-importable)
- [ ] `prompt.ts` re-exports `printTable` + `ColOpt` and the docstring
      mentions tabular output alongside prompts/progress
- [ ] `printTable` computes widths from max cell length per column
- [ ] `align: "right"` works for numeric columns
- [ ] `max` clamps and middle-truncates with `…`
- [ ] Last column truncates to terminal width (helper inlines the
      middle-truncate; doesn't depend on `prompt.ts`)
- [ ] Non-TTY path: TSV, no color, no padding, no truncation
- [ ] `formatRelPast` follows the spec table (1s / 60s / 5m / 1h / 1d boundaries)
- [ ] Unit tests for `table.ts` and `formatRelPast`

---

## Phase 2: `d plugin runs`

**User stories**: columns line up; relative time by default; pipe-safe.

Replace the inline `padEnd(7) / padEnd(20)` row with `printTable`. Default
time column is `formatRelPast(startedAt)`; add `-v` to also show the ISO.

**Acceptance:**
- [x] `d plugin runs` columns line up regardless of run-id suffix length
- [x] Default rows show e.g. `3m ago`, `2h ago`, `1d ago`
- [x] `d plugin runs -v` adds the exact ISO timestamp column
- [x] `d plugin runs | cat` emits TSV (no ANSI, no padding)
- [x] Existing test `plugin-runs.test.ts` still passes (no adjustment needed)

---

## Phase 3: `d collection list`

**User stories**: long collection names don't spill into next column.

Port the loop in `commands/collection.ts` to `printTable`. The current md
count + source layout from the recent commit stays the same; widths
become dynamic.

**Acceptance:**
- [x] `d collection list` and `d collection list -v` use `printTable`
- [x] Collections with names >20 chars no longer overflow
- [x] Count column right-aligned (matches current `padStart(5)` look)
- [x] `d collection list | cat` emits TSV

---

## Phase 4: `d plugin list`

**User stories**: columns line up; `-` schedule reads as "none".

`d plugin list` today prints `name<TAB>version<TAB>collections<TAB>schedule`
which collapses on most terminals into a ragged mess. Port to `printTable`;
right-align nothing (all left). Trailing `-` for "no schedule" stays.

**Acceptance:**
- [x] `d plugin list` columns align regardless of name/version width
- [x] Long collection lists (e.g. `spotify/songs,spotify/podcasts`) don't
      push the schedule column off-screen — middle-truncate via `max`
- [x] `d plugin list | cat` emits TSV

---

## Phase 5: `d search` — **deferred**

The `--preview` snippet row must align under the *title* column, which
means the caller needs to know `printTable`'s computed column widths to
build `previewIndent`. The helper computes widths internally and
deliberately doesn't expose them (deep-module contract). Migrating
would either:

  - duplicate the width computation in search.ts (more code, not less), or
  - leak widths back through `printTable`'s API (breaks the deep-module
    boundary for one caller).

`commands/search.ts` already uses the same dynamic-width / TTY-vs-TSV
pattern `printTable` codifies. Re-visit if a third caller ever needs
continuation rows under a specific column — then it's a real abstraction.

---

## Phase log

When starting implementation, rename this file to `./plans/<feature>-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. If git is available, stage and commit only that phase's changes after finishing, then continue to the next phase on your own. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/<feature>.md`.

| commit | summary |
|--|--|
| 00a862a | phase 1: table.ts + formatRelPast + tests + prompt.ts re-export (bundled into a parallel agent's commit due to a staging race; code is correct) |
