# Reusing an existing qmd index (deferred)

Sketched during the `qmd-library` spec, scoped out of v1. Captured here so we don't re-derive it later.

## What was on the table

When a user already runs qmd-CLI over (e.g.) `~/Documents/notes` and points dither at a path inside or alongside that tree, dither could **share the qmd index file** instead of building its own. Concretely: `dither` opens the same SQLite via `@tobilu/qmd` SDK, reads/writes there, qmd-CLI continues to work over the same file.

Two flavors discussed:

- **Adopt** — chosen library path is *inside* a registered qmd collection. Reuse the dbPath; no new qmd collection registered (parent's recursive `**/*.md` already indexes dither's writes).
- **Ask / register-new** — chosen path is a sibling to existing qmd state but not covered. Init prompts: register this folder as a new qmd collection (shared dbPath) or create a separate dither index.

Plus a "CLI-mode" earlier in the design where index *writes* would shell out to the `qmd` binary so the user's own tool stayed canonical. Dropped before it was written, same reasoning.

## Why deferred to a later version

Adopting / sharing an index complects several things that are clean when separate:

1. **Search filtering for adopted indices.** A shared qmd collection contains both the user's hand-written content and dither's plugin-promoted content. Without a post-filter, `dither search` (and any agent reading via MCP) leaks the user's personal files outside the grant model. Adding the filter is straightforward but it's another layer on every read path.
2. **Partial reindex breaks.** Fresh-mode dither registers each top-level subdir as a separate qmd collection, so `update({ collections: ["messages"] })` scopes neatly. Adopt-mode collapses everything under one shared parent collection — partial reindex re-scans the entire user library on every plugin promote.
3. **Collection-registration mismatch.** dither auto-discovers collections from filesystem subdirs; qmd-CLI requires explicit `qmd collection add`. Sharing a dbPath means dither has to keep qmd-CLI's collection list in sync, or accept that new dither subdirs aren't registered (and live "under" the parent's recursive pattern with all the filtering caveats from #1).
4. **Version skew.** Dither bundles a specific `@tobilu/qmd` SDK version. The user's qmd-CLI may be a different version with different schema. Two writers on one SQLite file is safe at the WAL level but undefined at the schema level. Either we pin and warn, or we refuse, or we silently break.
5. **Two writers, one dbPath, no clear owner.** The whole feature presupposes a coordination model dither doesn't have today.

For v1 the cleaner contract is: dither owns its index, period. The cost is that a qmd-CLI user pointing both tools at the same library ends up with two indices, two embedding bills, two on-disk SQLite files. That's wasted work but it's *correct* and *simple*.

## When this becomes worth doing

Real signal that index reuse should come back:

- A user (or several) explicitly asking for it — not us assuming they want it.
- A clear story for #1 (search filtering) and #2 (partial reindex scoping) that doesn't require N branches of conditional logic in the indexer / search paths.
- Upstream `@tobilu/qmd` exposing path-scoped (not just collection-scoped) `update()`, which mostly removes #2.

## Code touchpoints to revisit when the time comes

When this work picks up, the relevant places will be:

- The library / index resolver (currently always `<dither-home>/qmd-index.sqlite` per spec).
- `updateIndex()` and its callers — collection scoping logic, plus any new path-scoping if the SDK gains it.
- `search` / `get` — would need a library-path filter on results.
- `dither init` — adds a detection step probing for qmd-CLI state.
- Config schema — adds `library.db_path` (overriding the implicit default) and possibly a `qmd.cli_path` / `qmd.cli_version` informational block.

A short comment like `// see notes/qmd-index-reuse.md — index location is intentionally fixed in v1` at the resolver site is worth leaving when the spec implementation lands.
