# Plan: Nestable collections

> Source spec: `specs/nestable-collections.md`

## Architectural decisions

- **Grant model**: globs over collection-path identifiers, matched via `picomatch`. No implicit subtree from a literal grant. Standard glob semantics (`messages/**` matches descendants but not `messages` itself).
- **Manifest collections**: default seed only. No subset-of-manifest check at install time. Same simplification applies to `net`. The grants file is the source of truth at promote.
- **qmd**: untouched. Top-level dirs under `~/.dither/entries/` remain the only qmd collections; nesting is filesystem-only and falls out of qmd's existing `**/*.md` recursive glob.
- **Path validation**: per-segment `[a-zA-Z0-9._-]`, single `/` between segments, no leading/trailing `/`, no `..`, no `.md` suffix, no empty segments.
- **New module**: `collection-paths.ts` with `validateCollectionPath` and `grantsCover`. Pure, deep, no I/O.
- **Promote dest**: `~/.dither/entries/<segments>/<filename>.md`, with `mkdir -p` of the nested parent.

---

## Phase 1: Nested writes work, with grant globs and safety gates

**User stories**: 1, 2, 3, 4, 5, 6, 7, 9, 10

End-to-end: a plugin with manifest `collections: ["messages/**"]`, granted `messages/tom/**` at install, calls `writeEntry({ collection: "messages/tom" })` and the entry lands at `~/.dither/entries/messages/tom/<id>.md`. Hostile or misconfigured writes (`../../etc`, sibling-subtree, sibling-name) are rejected at promote.

**Acceptance:**

- [x] `collection-paths.ts` exports `validateCollectionPath` and `grantsCover` (picomatch-backed; matchers memoized per process).
- [x] `plugin-run.ts` validates the frontmatter `collection` value, then checks via `grantsCover`. Destination path built from path segments with `mkdir -p`.
- [x] Existing "ungranted collection" test in `plugin-host.test.ts` passes unchanged (back-compat regression guard).
- [x] New tests in `plugin-host.test.ts`: (i) `..` traversal rejected, (ii) `messages/tom/**` doesn't authorize `messages/jane`, (iii) `messages/**` doesn't authorize `messages-archive`, (iv) positive nested-write happy path.
- [x] Lint, typecheck, full test suite green.

---

## Phase 2: Manifest is no longer a ceiling

**User story**: 8 (back-compat) + simplification commitment.

End-to-end: `dither plugin install ./foo --allow-collection notes/personal` succeeds even when the manifest declared only `messages`. Same for `--allow-net`. Drop the subset check from `resolveAllowList`.

**Acceptance:**

- [ ] `plugin-install.ts` no longer rejects `--allow-collection` or `--allow-net` values absent from the manifest.
- [ ] New test: install widening `collections` past the manifest succeeds, plugin runs, output promotes.
- [ ] Doc updates in `plugins/index.mdx`, `plugins/authoring.mdx`, `cli/plugin.mdx` reflect "manifest = default seed, not ceiling."
- [ ] Lint, typecheck, full test suite green.

---

## Phase log

When starting implementation, rename this file to `./plans/<feature>-RUNNING.md`. Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. Stage and commit only that phase's changes after finishing. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/<feature>.md`.

| Commit | Summary |
| ------ | ------- |
|        |         |
