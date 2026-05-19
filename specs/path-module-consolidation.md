# Path module consolidation

> Architectural deepening — folds `paths.ts` into `config.ts` and splits `collection-paths.ts` into `collection-registry.ts` (path-shape validation) and a new `grants.ts` (Grant pattern + coverage).

## Problem Statement

Three modules in `packages/cli/src/` carry "path" in either their filename or their export list, but they sit at three completely different abstraction levels:

- `home.ts` — resolves `~/.dither/<something>`. Independent of library configuration. The natural home for dither-home paths.
- `paths.ts` — 28 lines. Wraps `loadConfig()` + `join()`. Provides four functions (`libraryRoot`, `collectionDir`, plus their `*FromConfig` mirrors).
- `collection-paths.ts` — 130 lines. Despite the name, it does no path **resolution**. Every export is **validation** logic for the `path:` value a plugin emits — segment rules, dotfile rejection, **Grant** glob coverage.

A caller wanting to know where a **Collection** lives on disk has to guess which of three modules holds the function. `paths.ts` is a thin pass-through that fails the deletion test: removing it pushes callers to `loadConfig()` then `join()` once, which is just as legible as the current wrapping. `collection-paths.ts` earns its keep but is misleadingly named — readers grep "path" expecting filesystem mechanics and find validation rules instead.

## Solution

- Move the four functions from `paths.ts` into `config.ts` as free functions over a loaded config object. Delete `paths.ts`.
- Split `collection-paths.ts`:
  - `validateCollectionPath` (and its internal segment validators) moves into `collection-registry.ts` — that module already owns **Collection** identity, and path-shape validation is part of identity.
  - `validateGrantPattern` and `grantsCover` move into a new `grants.ts` — these are the **Grant** machinery and belong with **Grant** concerns.
  - Delete `collection-paths.ts`.
- `home.ts` keeps its current scope: every path under `~/.dither/`. No change.

After: two path-shaped modules (`home.ts` for dither-home, `config.ts` for library-relative) plus two cleanly-scoped concern modules (`collection-registry.ts` for **Collection** identity including path-shape; `grants.ts` for **Grant** pattern + coverage).

## User Stories

1. As a CLI maintainer, I want one obvious place to find library-relative path resolution, so that I do not grep three files.
2. As a `commands/*` author, I want the loaded config object to know its own paths, so that `collectionDir` calls live with the config they read.
3. As a reader of the codebase, I want **Collection** path-shape validation to live next to **Collection** identity, so that I find both in one module.
4. As a **Grant**-machinery author, I want grant-pattern helpers in a dedicated `grants.ts`, so that **Grant** logic is not mixed with unrelated validation.
5. As a test author, I want path-derivation tests to live alongside config tests, so that the test surface matches the production surface.

## Implementation Decisions

### Config object as path source

**Q16 decided: (a) functions land in `config.ts`.** Trivial wrappers over a loaded config; co-locating them with the config type is more honest about where their data comes from.

**Q17 decided: (a) keep POJO + free functions.** Config stays a plain object; functions like `libraryRoot(cfg)` take it as an argument. The rest of the codebase uses POJO config — switching one type to a class would create style asymmetry for negligible win.

- `loadConfig()` continues to return the parsed JSON shape (no behavioural change to its current consumers).
- Two top-level helpers on `config.ts` replace `paths.ts`:
  - `libraryRoot(cfg)` and `collectionDir(cfg, name)` — pure, synchronous, take a loaded config as the first arg.
  - The async `libraryRoot()` / `collectionDir(name)` variants from `paths.ts` move to `config.ts` and call `assertInitialized()` internally.
- Net effect: same four functions, same names, different file. Callers update one import path.

### Split `collection-paths.ts`

**Q18 decided: (d) split.** The current single file mixes generic **Collection**-path validation with **Grant**-specific helpers; splitting removes the naming dilemma rather than papering over it.

- `validateCollectionPath` (and its internal segment validators) → moves into `collection-registry.ts`. That module already owns **Collection** identity; path-shape validation is part of identity.
- `validateGrantPattern` and `grantsCover` → new `grants.ts`. **Grant** pattern matching and **Grant** coverage queries are the **Grant** machinery's surface.
- `collection-paths.ts` is deleted in the same change.
- All imports update in one pass — most touch `validateCollectionPath` (callers do path validation before promote) or `grantsCover` (callers in `plugin-run.ts`).

### What does not move

- `home.ts` stays. It is the canonical dither-home resolver and was not part of the friction.
- `collection-paths.test.ts` is split: `validateCollectionPath` tests move into `collection-registry.test.ts`; grant tests move into a new `grants.test.ts`.

### Sequencing

- The `paths.ts` → `config.ts` move and the `collection-paths.ts` split are independent and can land in either order.

## Testing Decisions

- Existing `paths` tests (if any) merge into `config.test.ts`. The behaviour assertions stay: `libraryRoot()` reads from a loaded config; `collectionDir()` joins correctly.
- `collection-paths.test.ts` is split along the same lines as the production module: validation assertions to `collection-registry.test.ts`; grant assertions to `grants.test.ts`. Test bodies are untouched.
- No new tests are required — the change is structural.

## Out of Scope

- Changing the config schema or the on-disk config path.
- Introducing a `Library` or `Collection` class with methods.
- Validating `collection.path` at load time (validation today is per-call; that's deliberate).
- Touching `home.ts`.

## Further Notes

- The friction here is the smallest of the five candidates after `display.ts`. It is worth doing because every new CLI command has to choose between three "path" modules; one less guess per author multiplies across the team.
- No ADR — the decision is mechanical and easy to reverse.
