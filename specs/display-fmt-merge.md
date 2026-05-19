# display.ts merge into prompt.ts

> Architectural hygiene — folds the 22-line `display.ts` (one function, `tildePath`) into the documented CLI/TUI seam at `prompt.ts`.

## Problem Statement

`packages/cli/src/display.ts` is 22 lines and exports a single 4-line function: `tildePath`, which rewrites a path beginning with the user's home directory to start with `~`. Three modules import it: `commands/init.ts`, `commands/status.ts`, `qmd-download-render.ts`.

Meanwhile, `AGENTS.md` documents `packages/cli/src/prompt.ts` as the canonical home for CLI/TUI output. A new contributor reading that documentation expects formatting helpers to live there too. The `display.ts` module exists as an island.

The fix is mechanical, but the principle matters: a module that is too small to justify its file should not exist as a module. It is overhead.

## Solution

Move `tildePath` into `prompt.ts` and delete `display.ts`. Update the three import sites.

If `prompt.ts` ever accumulates a third or fourth purely-formatting helper that does not interact with stdio, a sibling `fmt.ts` may be worth extracting. That is a future judgement call; this spec does not pre-pave it.

## User Stories

1. As a new contributor, I want CLI/TUI helpers in one documented location, so that I do not grep two files for "how do I print a path".
2. As a CLI maintainer, I want the module count to reflect real seams, so that the codebase stays navigable.

## Implementation Decisions

**Q19 decided: (a) land in `prompt.ts` directly.** No new `fmt.ts` for a single 4-line function. If a third or fourth pure-format helper shows up later, extract then.

- `tildePath` and its inline tests move into `prompt.ts` (or `prompt.test.ts` for the tests). The function body is unchanged.
- `display.ts` is deleted in the same change.
- Three import statements update from `./display` (or `../display`) to `./prompt`.

## Testing Decisions

- Existing tests for `tildePath` (if separate) merge into the `prompt.ts` test file.
- No new tests are required.

## Out of Scope

- A new `fmt.ts` module. Speculation.
- Reworking `prompt.ts` itself.
- Touching `progress.ts` or `qmd-download-render.ts` — both earn their separate files.

## Further Notes

- This is the smallest of the five deepening specs and is safe to land first. No ADR.
