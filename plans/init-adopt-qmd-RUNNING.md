# Plan: init-adopt-qmd

> Source spec: `specs/init-adopt-qmd.md`

## Architectural decisions

- **Module**: new `qmd-import.ts` in `packages/cli/src/`. Two functions: `discoverQmdCollections(libraryPath)` (I/O, reads YAML from disk) and `applyQmdImport(cfg, result, librarySubdirs)` (pure, returns next cfg + adoption diff).
- **Discovery sources**: `~/.config/qmd/index.yml`/`.yaml` (global) + `.qmd/index.yaml`/`.yml` walked up from `library.path` (local). Local precedence on name conflict.
- **Adoption rules**: reuse `addExternal()` from `collection-registry.ts` for overlap + collision checks; catch `RegistryError` per-collection and warn-and-continue.
- **YAML parser**: `yaml@^2.8.3` (already in tree transitively via `@tobilu/qmd`).
- **Init wiring**: new step between `wrote config.json` and `indexing library...`. Silent when no qmd config found. Summary line when found.
- **Idempotence**: adoption happens once at init only. Re-init is already a no-op (`existing → return`). No re-discovery command in this plan.
- **What we read from qmd YAML**: `collections.<name>.path` only. Pattern/ignore/context/global_context/update/models/includeByDefault all ignored — see spec "What we read."

---

## Phase 1: Tracer — global qmd config adopted at init

**User stories**: 1, 2, 3, 6.

End-to-end: a user with `~/.config/qmd/index.yml` defining collections runs `dither init`. The global YAML is parsed; each collection's path is canonicalised; in-library paths are skipped; the rest are appended to `cfg.collections.external` via `addExternal`. A summary line ("✓ found qmd config…", "  adopted N collections: a, b, c", "  skipped M (in-library/invalid)") prints during init. A user with no qmd config sees zero behavioural change.

**Acceptance:**
- [x] `yaml` declared as a direct dep of `packages/cli`.
- [x] New module `qmd-import.ts` exports `discoverQmdCollections` + `applyQmdImport`.
- [x] `discoverQmdCollections` reads `~/.config/qmd/index.yml` (and `.yaml`); returns `{source, collections, warnings}` shape per spec.
- [x] `applyQmdImport` maps qmd collections → cfg externals: canonicalise, skip in-library, append via `addExternal`, catch and report `RegistryError` per-collection. Name-with-`/` sanitisation (replace with `-`). One-off name collision: skip with warning (rename-suffix loop comes in Phase 2).
- [x] `init.ts` calls discovery after `saveConfig`, prints summary, re-saves config with adopted externals.
- [x] Manual smoke: with a tmp `~/.config/qmd/index.yml` defining two collections (one inside library, one outside), `dither init` adopts the outside one and reports both correctly.
- [x] Existing `init.test.ts` still passes — no qmd config means silent no-op.

---

## Phase 2: Local walk-up + rename suffix + tests + warnings

**User stories**: 4, 5, 7.

End-to-end: `.qmd/index.yaml` walked up from library root is also discovered, with documented precedence over global on name clash. Name collisions get a `-1`, `-2` rename suffix instead of being skipped. Malformed YAML emits a warning and init continues. Missing/non-directory paths emit a warning and are skipped. Renames surface inline in the summary.

**Acceptance:**
- [x] `discoverQmdCollections` walks up from `libraryPath`, picks up the first `.qmd/index.yaml`/`.yml` it finds (stops at fs root). When both global and local exist, local entries win on name conflict in `applyQmdImport`.
- [x] Malformed YAML in either source: warning pushed to `result.warnings`, source treated as empty, init continues.
- [x] qmd collection with missing path or non-directory: warning, skipped.
- [x] Name collision (with library subdir or another adopted external) → rename `name-1`, `-2`, … until unique. Surface "(renamed from X)" in summary.
- [x] Unit tests for `applyQmdImport` covering: empty input, in-library skip, overlap skip, rename suffix, sanitised slash, same-name-twice, symlink canonicalisation.
- [x] Integration tests for `discoverQmdCollections` against a real tmp filesystem covering: no config, global only, local only, both, malformed YAML.
- [x] Init integration test (extending `init.test.ts`'s `captureLogs` pattern) covering: qmd config present → externals appear in saved config + summary printed; no qmd config → silent.
- [x] All existing tests still pass.

---

## Phase log

When starting implementation, rename this file to `./plans/init-adopt-qmd-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. If git is available, stage and commit only that phase's changes after finishing, then continue to the next phase on your own. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/init-adopt-qmd.md`.

| commit | summary |
|--|--|
| _pending_ | Phase 1: `yaml` dep added; `qmd-import.ts` with `discoverQmdCollections` (global only) + `applyQmdImport`; init wires discovery between library resolve and config write; smoke-tested with fixture qmd config (3 adopted, 1 skipped in-library). |
