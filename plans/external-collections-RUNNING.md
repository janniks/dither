# Plan: External Collections

> Source spec: `specs/external-collections.md`

## Architectural decisions

- **Config schema**: bump `schema.version` 1 → 2. New optional field
  `collections.external: { name: string; path: string }[]`. v1 configs
  load with `collections.external = []` (no forced migration write).
  v2 readers accept v1; older v1 readers safely ignore the new field.
- **CLI surface**: new top-level group `dither collection` with three
  subcommands — `add <path> [--name <name>]`, `list [--verbose]`,
  `remove <name>`.
- **Key model**: `Collection = { name; path; source: "library" |
  "external"; status: "ok" | "missing" }`. Derived freshly on each
  call by unioning library subdir scan with `config.collections.external`.
- **qmd registration**: each external becomes its own qmd collection,
  same `**/*.md` pattern, registered in `openStore` alongside library
  subdirs. Missing externals are warned-and-skipped.
- **Promote-time resolution**: top-segment of frontmatter `collection`
  → registry lookup. External hit → write under external path. No hit
  → existing fallback to `<library>/<collection>/`.
- **Daemon**: no changes. `collection add` runs qmd register + index
  inline; plugin runs spawn fresh and `loadConfig` per-run.
- **Grant model**: unchanged. Patterns match logical names; on-disk
  resolution happens after the grant check passes.

---

## Phase 1: Config schema bump + pure registry module

**User stories**: 13, 14, 15, 16, 21, 22

Stand up the v2 config field and a pure, deeply-tested
`collection-registry` module. Nothing user-visible yet, but the data
layer is stable and every validation branch is locked down.

Includes:

- Bump `CONFIG_SCHEMA_VERSION` to 2; loader accepts v1 transparently
  (treats missing `collections.external` as `[]`); v2 round-trips
  through save/load.
- New module exporting `defaultSlug`, `addExternal`, `removeExternal`,
  `loadRegistry`, `resolveCollection`, plus typed errors for each
  validation failure.
- Slug rules from the spec (lowercase, non-`[a-z0-9._-]` → `-`,
  collapse runs of `-`, trim, reject empty).
- `addExternal` does: realpath canonicalisation, exists/isDir/writable
  check, no-overlap-with-library (both directions), no-overlap-with-
  other-external (both directions), name validator + slash rejection,
  case-insensitive collision check against library subdir names and
  other externals.
- `resolveCollection` returns ok/missing with `source` discriminator.
- Exhaustive unit tests, one assertion per branch.

**Acceptance:**
- [x] `CONFIG_SCHEMA_VERSION === 2` and a v1 config (no `collections`
      field) loads with `collections.external = []`.
- [x] A v2 config with externals round-trips through `saveConfig` and
      `loadConfig` unchanged.
- [x] Unit tests cover: not-exists, not-dir, not-writable, overlap-
      with-library (both directions), overlap-with-external (both
      directions), slug collision (case-insensitive) with library
      subdir and external, slash-in-name, slug-empty-after-sanitise,
      default-slug examples (`Work Notes` → `work-notes`,
      `foo--bar` → `foo-bar`, trailing slash tolerated), and an
      add-then-remove round-trip equality.
- [x] `resolveCollection` returns `{ status: "missing" }` when the
      external path no longer exists at call time and `{ status: "ok",
      source: "library" | "external" }` otherwise.
- [x] `tsc --noEmit` clean; new unit tests pass.

---

## Phase 2: CLI subcommand group + qmd registration

**User stories**: 1, 2, 3, 4, 5, 6, 7, 17, 18, 19, 20

User-visible slice: `dither collection {add,list,remove}` works,
externals get indexed alongside library subdirs, and `list` flags
missing mounts.

Includes:

- New Citty subcommand group wired into `main.ts`.
- `add` calls `addExternal`, persists config, opens a store with the
  new external registered, calls `update({ collections: [name] })`,
  exits.
- `list` enumerates library subdirs + externals, prints a table;
  `--verbose` adds the on-disk path, file count, and `(missing)` tag.
- `remove` calls `removeExternal`, persists config, drops that
  collection's rows from the qmd index (`store.dropCollection(name)`
  or equivalent; if no API exists, use `update` with the registry
  shrunken — fall back to full re-register if needed).
- `openStore` is extended to register every healthy external from
  `config.collections.external` in addition to library subdirs.
  Missing externals are logged once and skipped.
- CLI smoke tests in `collection-cli.test.ts`: round-trip add+list+
  remove, missing-path flagged in list, remove-on-library-subdir
  errors.

**Acceptance:**
- [x] `dither collection add <tmp-dir>` writes config with a slug
      defaulted from the basename; the dir's existing `.md` files
      show up in `dither search` immediately after the command
      returns.
- [x] `dither collection add <tmp-dir> --name custom` honors the
      explicit name; subsequent `add` with a colliding name errors
      with a clear message.
- [x] `dither collection list` prints both library and external
      collections; `--verbose` adds the path and a file count;
      a removed-out-from-under-us external is annotated `(missing)`.
- [x] `dither collection remove <name>` drops the registry entry and
      the qmd rows; the files on disk are untouched; running it on
      a library subdir name errors.
- [x] `openStore` registers each healthy external as its own qmd
      collection with `**/*.md`; missing externals don't crash startup.
- [x] CLI smoke tests cover the above; existing tests still pass;
      `tsc --noEmit` clean.

---

## Phase 3: Promote-time path resolution + integration tests

**User stories**: 8, 9, 10

Plugins now write through to externals when the top segment of the
frontmatter `collection` matches a registered external. Auto-create
behavior for unknown names is unchanged. The four `plugin-host.test.ts`
scenarios pin the behavior.

Includes:

- `planPromotion` consults `loadRegistry` (or a thin
  `resolveCollectionByTopSegment` helper) on each candidate. Hit →
  `dest = <external.path>/<rest-of-path>/<filename>`. Miss →
  existing `join(libraryRoot, collection, filename)` path.
- `touchedCollections` (passed to `updateIndex`) uses the same
  top-segment as today; the qmd collection name is identical whether
  rooted in library or external.
- Missing-external case: `planPromotion` errors for that one entry
  with a clear message; the rest of the run promotes; per the
  existing two-pass design, no partial promote is possible inside a
  single run, so a missing external currently fails the *whole* run.
  Decision: keep the existing all-or-nothing run semantics — a
  missing external is a hard run failure with a clear error. This
  preserves the two-pass invariant. Spec story #19 ("operations on
  *other* collections keep working") is satisfied at the
  *between-runs* level (other plugins / other commands), not within
  a single run's outputs.
- Integration tests added to `plugin-host.test.ts` matching the
  pattern in `nestable-collections.md`.

**Acceptance:**
- [x] Plugin granted `work-notes/**`, with `work-notes` registered as
      an external pointing at `<tmp>/work`, writes `collection:
      "work-notes"` → file lands at `<tmp>/work/<filename>`, NOT under
      the library.
- [x] Same plugin writes `collection: "work-notes/sub/2026"` → file
      lands at `<tmp>/work/sub/2026/<filename>`.
- [x] Plugin granted `fresh/**` writes `collection: "fresh"` with no
      registry entry → file auto-creates at `<library>/fresh/<filename>`
      (regression guard).
- [x] Plugin promotes into an external whose path was deleted after
      registration → run fails with a clear "external missing"
      message; no files written.
- [x] `tsc --noEmit` clean; all tests pass.

---

## Phase log

When starting implementation, rename this file to `./plans/external-collections-RUNNING.md`. Work one phase at a time, ticking each acceptance criterion as it lands. Stage and commit only that phase's changes after finishing, then continue. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/external-collections.md`.

| commit | summary |
|--|--|
|  |  |
