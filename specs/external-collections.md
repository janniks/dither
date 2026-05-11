# External Collections

## Problem Statement

A user already has folders of hand-written `.md` scattered across disk
(`~/Documents/work-notes/`, `~/Notes/messages/`, etc.) and wants dither
to treat them as first-class collections — searchable via `dither
search`, grant-checkable from plugin manifests, and writable as targets
when a plugin promotes into a collection name the user has already
mapped to one of those folders. Today dither only knows about
subdirectories under the configured library root, so any pre-existing
folder has to be copied or symlinked in, which the user doesn't want.

## Solution

Add an **external collection registry** alongside the library. The
library remains the home for auto-created collections (when a plugin
promotes to an unknown collection name, it auto-creates there, exactly
as today). Externals are sibling mounts the user explicitly registers
via `dither collection add`. At promote time, the host resolves the
target collection: registry hit → write to the external path; no hit →
fall back to `<library>/<collection>/`. qmd indexes both sets
uniformly, each registered as its own qmd collection with the existing
`**/*.md` pattern.

The model is intentionally close to qmd-CLI's `qmd collection add <path>
--name <name>` so the mental model transfers; the differences are
(i) `--name` is optional and defaults to a slug of the folder leaf,
(ii) external names are flat (no `/`) so they don't conflict with the
existing nestable-collections rule that "qmd collection name = top
segment of logical path".

## User Stories

1. As a user with a hand-curated `~/Documents/work-notes/` folder, I
   want to register it as a dither collection without copying or moving
   any files, so that I can search across it from `dither search`
   alongside plugin-promoted content.
2. As a user, I want `dither collection add ~/Documents/work-notes` to
   pick a sensible default name (`work-notes`) from the folder leaf, so
   that the common case is one positional argument.
3. As a user with two folders that share a basename
   (`~/work/notes` and `~/personal/notes`), I want to pass `--name` to
   disambiguate, so that both can coexist as distinct collections.
4. As a user, I want `dither collection list` to show every collection
   — library subdirs and externals — with its on-disk path, so that I
   can see at a glance where everything lives.
5. As a user, I want `dither collection list --verbose` to add file
   count and last-indexed time per collection, so that I can spot
   stale or empty ones.
6. As a user, I want `dither collection remove <name>` to unregister
   an external collection without deleting any of its files, so that
   the operation is safe to run by mistake.
7. As a user, I want `dither collection remove` to refuse to unregister
   a library subdir, so that the filesystem stays the source of truth
   for in-library collections.
8. As a plugin author, I want my manifest's `collections:
   ["work-notes/**"]` grant to work identically whether `work-notes`
   resolves to a library subdir or an external mount, so that I don't
   need to know or care about the user's registry.
9. As a plugin author, I want `writeEntry({ collection: "work-notes",
   ... })` to land at the correct on-disk path automatically, so that
   the SDK contract doesn't change.
10. As a plugin author, I want `writeEntry({ collection:
    "work-notes/sub/2026", ... })` to land at
    `<external-path>/sub/2026/...` when `work-notes` is registered as
    an external, so that nestable-collections semantics carry over
    unchanged.
11. As a user, I want `dither collection add` to reject a path that is
    inside the library (or contains it), so that no file is indexed
    under two different collection names.
12. As a user, I want `dither collection add` to reject a path that
    overlaps another registered external, so that the registry stays
    unambiguous about which mount owns which files.
13. As a user, I want `dither collection add` to reject a `--name`
    containing `/`, so that the "qmd collection = top segment of
    logical path" invariant holds for externals too.
14. As a user, I want `dither collection add` to reject a path that
    isn't a writable directory, so that a typo or a stale path fails
    loudly at add time, not silently later.
15. As a user, I want `dither collection add` to canonicalise the path
    (`realpath`) before storing it, so that a later symlink swap can't
    silently widen the collection's scope (same posture as
    `dither init --library`).
16. As a user, I want a default name that collides with an existing
    collection (library or external) to error and tell me to pass
    `--name`, so that I never accidentally shadow a collection.
17. As a user, I want `dither collection add` to index the new external
    inline before returning, so that the very next `dither search`
    sees its contents.
18. As a user, I want `dither collection remove <name>` to drop just
    that one qmd collection's rows from the index, so that other
    collections stay indexed and search results are clean.
19. As a user, if an external mount's path is missing at runtime
    (drive unplugged, folder moved), I want operations on other
    collections to keep working and the missing one to be flagged in
    `collection list`, so that one unmounted volume doesn't break my
    whole tool.
20. As a user, I want a missing external to be skipped during qmd
    index updates and plugin promotes with a warning, never
    auto-pruned from the registry, so that a transient unmount doesn't
    lose my configuration.
21. As a user with a v1 `config.json` on disk, I want my install to
    keep working after the schema bump, so that I don't have to
    re-init.
22. As a plugin author writing to a new (unregistered) collection name,
    I want the entry to land in the library under that name, so that
    auto-creation still works exactly as it does today.

## Implementation Decisions

### Data model

- `DitherConfig.schema.version` → 2. v1 configs load with
  `collections.external = []`; no migration write is forced.
- New field: `collections.external: { name: string; path: string }[]`.
  `path` is canonical (post-`realpath`). `name` matches the existing
  collection-path validator and contains no `/`.

### CLI surface

- `dither collection add <path> [--name <name>]`
- `dither collection list [--verbose]`
- `dither collection remove <name>`

The `collection` subcommand group earns its namespace with three
commands; `--verbose` on `list` subsumes a separate `info` command.
Deferred: `rename` (use remove+add and accept reindex), `move` (same).

### Default name

Default `--name` is `basename(path)` lowercased, spaces and any chars
outside `[a-zA-Z0-9._-]` replaced with `-`, collapsed runs of `-`
folded to one, leading/trailing `-` trimmed. If the slug is empty or
collides with an existing collection name (case-insensitive), `add`
errors and instructs the user to pass `--name`.

### Validation at `add` time

In order, on the canonicalised input path:

1. Path exists, is a directory, is writable.
2. Path is not inside `library.path` and does not contain `library.path`.
3. Path is not inside any registered external's path and does not
   contain any registered external's path.
4. Name passes the existing collection-path validator (`alphanum +
   ._-`, no `..`, no leading/trailing `/`, no `.md` suffix) AND
   contains no `/`.
5. Name does not collide with any existing collection
   (case-insensitive), where "existing collection" is the union of
   library top-level subdir names and registered external names.

### Promote-time path resolution

`planPromotion` consults the registry by **top segment** of the
entry's frontmatter `collection`:

- Top segment matches a registered external name → entry lands at
  `<external.path>/<rest-of-path>/<filename>`.
- Top segment does not match → fall back to current behavior:
  `<library>/<collection>/<filename>` (auto-creates).

Nestable-collections semantics are preserved: `messages/tom/2026` with
`messages` registered as an external resolves to
`<external>/tom/2026/...`. Same as how it works for library subdirs
today.

### qmd index registration

`openStore()` continues to register each library top-level subdir as
its own qmd collection (`pattern: "**/*.md"`), and additionally
registers each external from the registry with the same pattern, rooted
at its external path. Missing externals (path no longer exists or is
unreadable) are logged and skipped — qmd is not asked to register a
nonexistent root.

### Missing-at-runtime

A small helper, `resolveCollection(name) → { path, status: "ok" |
"missing" }`, is consulted by promote, index, and list. Missing
externals are warned-and-skipped, never auto-pruned. `collection list`
annotates the row.

### Daemon

No daemon changes. `reconcile()` only runs at startup and on SIGHUP,
and the daemon doesn't read the collection registry. Plugin runs spawn
fresh child processes that read the registry per-run via `loadConfig`.
`collection add` handles its own qmd register + initial index inline.

### Grant model

No manifest or grant-file changes. Grant patterns match the logical
collection name; resolution to the on-disk path happens after the
grant check passes. A plugin granted `work-notes/**` can write to
`work-notes/anything/below`, whether `work-notes` is a library subdir
or an external mount.

### Modules

1. **`collection-registry.ts` (new, deep, pure).** Single source of
   truth for "what collections exist". Exports:
   - `loadRegistry(cfg, libRoot) → Collection[]` (union of library
     subdir scan + config externals).
   - `resolveCollection(registry, name) → { path; status: "ok" |
     "missing"; source: "library" | "external" }`.
   - `addExternal(cfg, path, name?) → cfg'` — runs all add-time
     validation, returns updated config. Throws typed errors.
   - `removeExternal(cfg, name) → cfg'` — throws if name isn't a
     registered external (library subdirs cannot be removed via this
     path).
   - `defaultSlug(path) → string` — pure slugifier.
   - Side effects limited to `lstat` / `realpath` for canonicalisation
     and exists/writable checks in `addExternal`. No qmd, no daemon, no
     CLI.
2. **`commands/collection.ts` (new, thin Citty subcommand group).**
   `add` / `list` / `remove` wire `collection-registry` to config
   load/save and qmd register/unregister + initial index. ~120 lines.
3. **Touch-ups, no new abstractions:**
   - `config.ts`: bump schema to 2, default empty `collections.external`.
   - `store.ts` (`openStore`): also register each external as a qmd
     collection; skip missing.
   - `plugin-run.ts` (`planPromotion`): consult the registry by
     top-segment lookup; fall back to library.
   - `main.ts`: register the new subcommand group.

## Testing Decisions

A good test here exercises the same path real users do: load real
config, write a real entry, assert the file ends up where it should.
Internal helpers stay un-mocked.

### Unit (in `collection-registry.test.ts`, new)

Pure module → exhaustive table of validation branches:

- Path not exists / not a dir / not writable → typed error each.
- Path inside library / contains library → typed error each direction.
- Path inside another external / contains another external → typed
  error each direction.
- Name collision with library subdir (case-insensitive) → error.
- Name collision with another external (case-insensitive) → error.
- Name contains `/` → error.
- Empty slug after sanitisation → error.
- Default-slug examples: `~/Notes/Work Notes` → `work-notes`,
  `~/foo--bar/` → `foo-bar`, trailing slash tolerated.
- Round-trip: `addExternal` then `removeExternal` returns config equal
  to the original.
- `resolveCollection` distinguishes ok/missing/library/external sources.

### Integration (extend `plugin-host.test.ts`)

Mirrors the nestable-collections pattern (and reuses its fixtures):

1. Plugin promotes `collection: "work-notes"` after the user has
   registered `~/<tmp>/work-notes` as an external → file lands at
   `~/<tmp>/work-notes/<filename>`, NOT under the library.
2. Plugin promotes `collection: "work-notes/sub/2026"` with `work-notes`
   registered → file lands at `~/<tmp>/work-notes/sub/2026/<filename>`.
3. Plugin promotes `collection: "fresh-name"` with nothing registered
   under that name → auto-creates `<library>/fresh-name/<filename>`
   (regression guard for unchanged auto-create path).
4. External path is removed between `add` and the next plugin promote
   → that entry's promote errors with a clear "external missing"
   message, the rest of the run continues, run is recorded as failed
   for that entry only.

### CLI smoke (extend `init.test.ts` style, new
`collection-cli.test.ts`)

- `add` writes config and indexes; `loadConfig` round-trips name+path.
- `add` indexes the new mount inline (a `.md` placed before `add`
  shows up in `qmd-index.sqlite` after the command returns).
- `list` prints library + external rows; `--verbose` adds the path
  and (smoke-only) a file count.
- `list` flags a missing-path row.
- `remove` drops the registry entry and the qmd rows for that
  collection; does not touch the files on disk.
- `remove` errors when given a library subdir name.

### Skip

- Daemon-specific tests (no daemon changes).
- Search ranking / qmd internals (covered by qmd's own contract).
- File-watching externals for change detection (out of scope).

Prior art: `init.test.ts` for CLI command tests with `mkdtempSync`
sandboxes, `plugin-host.test.ts` for promote-pipeline integration
tests, `nestable-collections.md`'s four-test pattern for boundary
behavior.

## Out of Scope

- Remote/cloud-backed collections (S3, WebDAV, etc.).
- Multiple libraries at runtime.
- Importing qmd-CLI's collection registry on init.
- Read-only external mounts (a per-mount `readonly: true` flag).
- File-watching externals for change detection. Index refresh happens
  via the existing scheduled `index update` and the inline index on
  `collection add`.
- `rename` and `move` subcommands. Equivalent via `remove` + `add`,
  accepting a one-time reindex.
- A `--mask` parameter (qmd has one). v1 always uses `**/*.md`.
- Cross-collection deduplication of identical content.
- `init`-time auto-detection of likely external folders to prompt for.

## Further Notes

- Schema bump is a one-way ratchet: v2 readers must accept v1 (treat
  missing `collections.external` as `[]`); v1 readers will simply
  ignore the new field if they ever encounter a v2 config, which is
  safe because they predate the feature anyway.
- The decision to keep names flat for externals while logical-path
  nesting continues to work *inside* a collection means there's still
  exactly one ambiguity-free rule: the qmd collection name is always
  the top segment of the logical path, and the registry is a flat
  name → root-path map.
- If a third use case for "non-library writable target" appears later
  (per-plugin output dirs, read-only adopted folders, remote stores),
  the registry is the natural growth point: add a `kind` discriminator
  on the entry rather than introducing a parallel concept.
