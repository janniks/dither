# Plan: qmd library

> Source spec: `specs/qmd-library.md`

## Architectural decisions

- **Config file**: `<dither-home>/config.json`. Two-level shape (section / key). Written plain JSON; parsed JSONC-tolerant so hand-edited comments survive.
- **Schema (v1)**: `{ "schema": { "version": 1 }, "library": { "path": "..." } }`.
- **Library default**: `<dither-home>/library` if no `--library` flag. Recommended user choice: an external dedicated folder.
- **Index dbPath**: always `<dither-home>/qmd-index.sqlite`. Not in config in v1. (Future spec: `notes/qmd-index-reuse.md` may add `library.db_path`.)
- **Indexer**: bundled `@tobilu/qmd` SDK only. No qmd-CLI subprocess, no qmd-CLI detection. Dither always owns the index.
- **Collection model**: mirror — each top-level subdir of the library is one qmd collection. Lazy registration on first promote (already implicit in current `store.ts` behavior — re-asserted here).
- **Init is required**: library-needing commands refuse with the standard error until `<dither-home>/config.json` exists. Commands that don't need the library (`--help`, `--version`, `daemon status` showing "no config", `init` itself) keep working.
- **Reconfig**: `dither init --force` only. No separate `dither config set` in v1.
- **Path canonicalisation**: library path resolved with `realpath` at init, pinned against symlink swap (same rationale as install-time file grants).
- **Pre-init error message**: `error: dither is not initialized. Run \`dither init\` to set up your library.` — exit non-zero, no fallback.
- **Out of scope** (deferred to follow-up specs): index reuse / adopt-mode (`notes/qmd-index-reuse.md`), multiple libraries, `dither config set`, `dither qmd:<command>` passthrough, hot-reload of library on SIGHUP, atomic move of library content on reconfig.

---

## Phase 1: Init writes config; pre-init guardrails land

**User stories**: 5 (idempotent init), 6 (clear pre-init errors).

The `config` module exists and the `dither init` command is wired up, but the rest of the codebase still resolves library paths as it does today (hardcoded `<dither-home>/entries/`). This isolates the config-write surface and the guardrails from the bigger resolver refactor in Phase 2.

`dither init` with no flags creates `<dither-home>/config.json` containing `{ schema: { version: 1 }, library: { path: "<dither-home>/entries" } }` — i.e. the path it writes matches what the codebase still uses, so nothing breaks. Re-running prints the current config and exits 0.

Library-needing commands (`search`, `get`, `list entries`, `index update`, `plugin install`, `plugin run`, `daemon start`) gain a `assertInitialized()` call at entry and exit non-zero with the standard error if config is missing.

**Acceptance:**
- [x] `config` module loads, saves, and validates the v1 schema; round-trips JSON; tolerates JSONC comments on read; rejects malformed input with a typed error.
- [x] `dither init` writes `<dither-home>/config.json` with `library.path = <dither-home>/entries` (the current implicit default) and exits 0.
- [x] Re-running `dither init` prints current config and exits 0 without rewriting.
- [x] All library-needing commands exit non-zero with the standard pre-init error when config is missing.
- [x] Existing pipeline / search / plugin-run tests are updated to call init (or pre-write a fixture config) at setup; they otherwise behave unchanged.
- [x] Test: pre-init guardrail fires for at least one representative command per surface (CLI dispatch, plugin install, daemon start).

---

## Phase 2: Library lookup routes through config

**User stories**: 2 (working default library), 3 (metadata separate from library).

The home module is split into two clearly-typed surfaces: dither-home paths (no config dependency) and library paths (config-backed). All callsites that resolve library paths — `store`, `plugin-run` (promote target), `watcher`, `commands/index` — are refactored to read from loaded config. Init's default library path moves from `<dither-home>/entries` to `<dither-home>/library`.

This is the phase where the conceptual split between dither-home and library becomes real on disk.

**Acceptance:**
- [x] `home.ts` (or its successor) exposes two non-overlapping surfaces: dither-home paths and library paths. Library helpers take loaded config; dither-home helpers don't.
- [x] No call to `<dither-home>/entries` survives in the codebase except as a one-time legacy mention in tests being migrated.
- [x] `dither init` (no flags) writes `library.path = <dither-home>/library` and creates that directory.
- [x] End-to-end pipeline test: init → plugin install → plugin run → promoted file lands in `<dither-home>/library/<collection>/...` → search finds it. (`library-resolver.test.ts` covers this with an external library path; the `<dither-home>/library` default is exercised by `init.test.ts`.)
- [x] Test: dither-home paths (pid, status, locks, plugins, grants, runs, env, config) are unaffected by changes to `library.path`.

---

## Phase 3: External library via `--library`

**User stories**: 1 (point dither at any folder), 10 (coexist with qmd-CLI without trampling).

`dither init --library <path>` accepts an external directory. Validation: doesn't exist → create with parents; exists as file → error; exists not writable → error. Path is canonicalised via `realpath`. Demo: `dither init --library ~/Documents/dither` and the full pipeline works against an external folder; dither's index sits at `<dither-home>/qmd-index.sqlite` regardless.

**Acceptance:**
- [x] `dither init --library <path>` writes that path (canonicalised) into `library.path`.
- [x] Non-existent path is created (with parents); a created path is reported in the init output.
- [x] Path that's a file → init exits non-zero with a clear error.
- [x] Path that's a non-writable directory → init exits non-zero with a clear error.
- [x] Symlinked path is canonicalised at init; subsequent moves of the symlink do not silently widen the library scope.
- [x] End-to-end pipeline test: init against an external tmp library → plugin promote → file lands in the external library → search finds it. (Covered by `library-resolver.test.ts` from Phase 2; init-flag entry path covered by `init.test.ts`.)
- [x] qmd index lives in dither home (`<dither-home>/qmd-index.sqlite`) regardless of where the library is.

---

## Phase 4: Partial reindex via touched-collection set

**User stories**: 8 (incremental indexer).

`updateIndex` gains an optional `collections?: string[]` argument and forwards to `store.update({ collections })`. `plugin-run` builds the touched-collection set from the promoted-paths return and passes it. Manual `dither index update` continues to do a full rescan (no scope).

**Acceptance:**
- [ ] `updateIndex(collections?)` exists; default behavior (no arg) is a full rescan, unchanged.
- [ ] Plugin promote computes the touched-collection set from the just-promoted paths and passes it to the indexer.
- [ ] Test: a plugin promoting into one of multiple collections triggers a scoped `store.update({ collections: [<that one>] })`. Asserted via SDK call shape (mock or counter), or via observable indexed-count if cleaner.
- [ ] `dither index update` (manual command) still calls `updateIndex()` with no scope.

---

## Phase 5: `--force`, `--no-download`, weight pre-fetch

**User stories**: 4 (pre-download weights), 7 (swap library later).

Init grows three flags:
- `--force` — overwrite existing config. Library path takes effect; old library left on disk for the user. qmd index is rebuilt: dbPath unchanged, old collections dropped from the in-memory store config and re-registered from the new library's subdirs, full `store.update()` runs once.
- `--no-download` — skip model weight prefetch (CI / offline use).
- Weight prefetch step itself runs by default. Failure is non-fatal but flagged in the final summary; search falls back to lex-only until weights land.

`notes/init-command.md` is folded into the spec and deleted.

**Acceptance:**
- [ ] `dither init --force --library <new>` overwrites `library.path`, leaves old library on disk untouched, rebuilds the qmd index against the new library.
- [ ] `dither init` (default) attempts to pre-download qmd model weights. Success and failure paths both leave init exit-0 if the rest of init succeeded; failure is flagged in the printed summary.
- [ ] `dither init --no-download` skips the prefetch step entirely.
- [ ] `notes/init-command.md` is deleted; its substance is in the spec.
- [ ] Test: reconfig drops old subdirs from the registered collection set in the new index.
- [ ] Test: `--no-download` produces a config + library + index but no weights on disk.

---

## Phase log

When starting implementation, rename this file to `./plans/qmd-library-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. Stage and commit only that phase's changes after finishing, then continue to the next phase. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/qmd-library.md`.

| commit | summary |
|--------|---------|
| 621dbc8 | Phase 1: config module (load/save/assertInitialized), `dither init` subcommand, pre-init guardrails on search/get/index-update/plugin-install/plugin-run/daemon-start. Init writes `library.path = <dither-home>/entries` (matches existing default). |
| ed8542f | Phase 2: split home.ts into dither-home paths and library paths (new paths.ts). Route store/plugin-run/watcher/status through loaded config. Default library moves to `<dither-home>/library`. New library-resolver.test verifies external library + clean dither home. |
