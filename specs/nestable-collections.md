# Nestable collections

## Problem Statement

Today a dither collection is a flat string — one folder under `~/.dither/entries/`. Users want collections to be nestable so a plugin can write into a sub-path like `messages/tom`, and a grant on a parent path can authorize an entire subtree without enumerating leaves. The current grant model can only express exact-string matches, which forces either one collection-grant per leaf (unworkable for plugins like an iMessage sync that creates a directory per chat) or one giant grant that can't be scoped.

## Solution

Collections become path identifiers (`messages/tom/2026`) and grants become globs over those paths (`messages/**`, `messages/tom/*`). The grant check at promote time is glob-match against the entry's frontmatter `collection` value. The qmd index is untouched: it continues to register only the top-level dirs under `~/.dither/entries/` as qmd collections, and qmd's default `**/*.md` glob already pulls in nested `.md` files. Search by top-level collection name therefore returns the whole subtree for free; finer-grained subtree search is a future concern, not part of this spec.

## User Stories

1. As a plugin author, I want my plugin's manifest to declare a broad target like `messages/**`, so that I don't need to enumerate every chat I might write into.
2. As a user installing a plugin, I want to grant only `messages/tom/**`, so that a noisy plugin can only land entries in one chat's subtree.
3. As a user, I want granting `messages` (no glob) to authorize _only_ the literal `messages` collection — not its descendants — so that grant writeups remain explicit and predictable.
4. As a user, I want granting `messages/**` to authorize all descendants of `messages` but not the bare `messages` collection itself, matching standard glob semantics.
5. As a user, I want granting `messages` not to leak into `messages-archive`, so that sibling-named collections are never accidentally authorized.
6. As a plugin author, I want to compute my entry's collection at run time (e.g. from an env value) and pass it to `writeEntry({ collection })`, so that one plugin can shard output across nested paths.
7. As a user, I want `dither search --collection messages` to keep returning entries from the whole subtree under `messages/`, so that I don't need to know the nesting layout to find things.
8. As a user, I want my existing flat collection grants and entries (no `/` in any name) to keep working identically after this change, so that nothing I've installed breaks.
9. As a user, I want a hostile plugin that writes a `collection` value like `../../etc` or with embedded leading slashes to be rejected at promote, so that grants cannot be escaped via path tricks.
10. As a maintainer, I want the grant check to be a single function over `(grants, collection)`, so that adding new check sites later is straightforward.

## Implementation Decisions

- **Grants are globs.** A grant string is a glob pattern matched against the entry's concrete `collection` path. Use `picomatch` for matching. Standard glob semantics: `messages` is exact, `messages/*` is direct children only, `messages/**` is all descendants (does not include `messages` itself), `messages/2026-*` is partial-segment match. To grant a parent and all its descendants, supply both: `messages,messages/**`.
- **No segment-prefix shortcut.** Granting `messages` does _not_ authorize `messages/tom`. This is intentional — implicit subtree authorization from a literal grant is dangerous; the user must opt into a subtree explicitly via `**`.
- **Sibling-prefix safety.** Glob matching naturally rejects `messages-archive` under `messages/**` because globs are segment-aware (the `/` is a hard separator). No string-prefix leak is possible.
- **Manifest `collections` is a default seed only.** The manifest's list serves as the install-time default for the grant when no `--allow-collection` is supplied. There is no "subset of manifest" check at install. The grants file is the source of truth at promote time. (When and whether the manifest default is auto-applied vs. prompted is governed by a separate spec on interactive prompts and CLI flags; this spec assumes the default behavior unchanged.)
- **Same simplification for `env` and `net`.** Drop the existing "install grant must be a subset of manifest" enforcement for those too. Manifest = default; flag = override; grants file = truth. One model across all four grant kinds.
- **No reads/writes split.** `collections` is the only collection-grant field. Read-side gating is a future spec.
- **qmd is untouched.** `openStore` continues to register top-level dirs under `~/.dither/entries/` as qmd collections with the default `**/*.md` glob. Nesting under those dirs is filesystem-only and indexed by qmd's existing recursion. We do not introduce qmd `context` maps or any other qmd feature in this spec.
- **Path validation rules** (applied to the entry's frontmatter `collection` value at promote, and to grant strings at install):
  - Non-empty.
  - Per segment: `[a-zA-Z0-9._-]` only.
  - Segments separated by single `/`. No leading or trailing `/`. No empty segments (no `//`).
  - No `..` segment anywhere.
  - No trailing `.md` (or any file extension); the path identifier names a directory, not a file.
  - Case-sensitive — the filesystem decides; no normalization on dither's side.
- **Promote path:** the entry's destination becomes `~/.dither/entries/<...split path segments>/<filename>.md`, with `mkdir(dirname(dest), { recursive: true })` to create any nested parents.
- **`writeEntry` SDK:** no API change. The `collection` field already accepts a string; that string can now contain `/`.

### Modules

- **`collection-paths.ts` (new, deep, isolated).** Two exports: `validateCollectionPath(path: string): void` (throws on rule violations) and `grantsCover(grants: string[], collection: string): boolean` (true iff any glob in `grants` matches `collection`). Memoizes compiled picomatch matchers per process. No I/O, no other dither dependencies.
- **`plugin-run.ts` (light edit).** Replace the current `Set.has(collection)` check with `grantsCover(grants.collections, collection)`. Validate the extracted `collection` value via `validateCollectionPath` before the grant check (so a malformed value is rejected with a clear error, not a silent miss). Change the destination path from `join(home, "entries", collection)` to a path built from split segments, and ensure `mkdir(dirname, { recursive: true })`.
- **`plugin-install.ts` (light edit).** Drop the subset-of-manifest enforcement for `collections` (and for `env` / `net`, per simplification above). Validate every grant glob via `validateCollectionPath` semantics — except that `*` and `**` are obviously allowed where a segment would otherwise need a literal name. (Concretely: validate by replacing `*` and `**` segments with a placeholder before the regex check, or accept them as valid segments in the validator.)
- **`store.ts` / `update-index.ts` / `openStore`:** no changes.
- **CLI flag parsing:** unchanged; `--allow-collection 'messages/**,notes/personal'` already comma-splits. Just stop rejecting `/` in values if any code does.

### Backwards compatibility

Flat names (no `/`, no `*`) work identically. A grant of `notes` matches a frontmatter `collection: "notes"` entry exactly the same way it did before. Existing fixtures and tests with flat collection grants pass unchanged.

## Testing Decisions

Four integration tests in `plugin-host.test.ts`. They pin the security claims by running through the real install + promote pipeline:

1. **Path-traversal rejected.** A plugin writes `collection: "../../etc/passwd"`. Promote fails with a validation error; nothing is written outside `~/.dither/entries/`.
2. **Sibling subtree isolation.** A plugin granted `messages/tom/**` writes to `messages/jane/x`. Promote rejects; the file does not appear under `entries/messages/jane/`.
3. **Sibling-name leak prevented.** A plugin granted `messages/**` writes to `messages-archive/x`. Promote rejects; nothing under `entries/messages-archive/`.
4. **Backwards compatibility.** A plugin granted `["allowed"]` writes to `allowed`. Promote succeeds and the file lands at `entries/allowed/<id>.md`. (Mirrors the existing pre-change test exactly; serves as a regression guard.)

No standalone unit test file for `collection-paths.ts`. The integration tests above exercise both `validateCollectionPath` and `grantsCover` through the production path, which gives a stronger guarantee than isolated unit tests for the surfaces that matter (security gates).

Prior art: the existing "refuses to promote entries written to an ungranted collection" test in `plugin-host.test.ts` is the template for shape and assertions.

## Out of Scope

- **Subtree-scoped search** (e.g. `dither search --scope messages/tom/`). qmd's recursion handles it implicitly today; finer scoping waits until a real user need.
- **Read gating.** A `reads`-style grant for collections a plugin can ingest from. Future spec.
- **qmd `context` maps** per nested prefix. Future, when an LLM-ranking use case emerges.
- **Interactive prompting and `--accept-defaults` / non-interactive flag semantics.** Separate spec; orthogonal to grant shape.
- **Migration of plugin manifests.** None needed — old flat names are valid globs (exact literal match).

## Further Notes

- The simplification of dropping "manifest is ceiling" enforcement for `env` and `net` was decided here for consistency with `collections`. The implementation should make that change in the same patch so the three grant kinds remain symmetric.
- `picomatch` is already a transitive dep of common JS tooling; if a smaller alternative is preferred at implementation time, that's a free swap as long as the same glob semantics hold (especially the segment-aware `/` boundary and `**` recursion).
