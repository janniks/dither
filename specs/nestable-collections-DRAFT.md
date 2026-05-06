---
status: draft
---

# Nestable collections

## Decisions so far

- **Q1+Q3 (revised): Grant matching is glob-based, no implicit subtree.** Granting `messages` matches *only* `messages` (exact). Descendants require an explicit pattern: `messages/**` (all descendants), `messages/*` (direct children only), `messages/2026-*` (partial segment). Rationale: implicit subtree from prefix is dangerous; globs are more explicit. Standard glob semantics (e.g. `messages/**` matches descendants but not `messages` itself; grant both if you want both).
- **Q2 / Q2.1: Manifest `collections` are defaults, not ceilings.** The manifest entry seeds the install grant — same model as env defaults. The user can override or extend at install. The grant in `grants/<name>.json` is what actually gates promote at run time. Plugins can also parameterize their target collection name via env, and the resulting frontmatter `collection` is validated against the grant set as usual.
- **Drop reads/writes split.** Just `collections` everywhere. Read gating is a future concern.
- **Q4: Storage = Model B. qmd-collection ≠ grant-collection.** qmd's view of the world stays as it is today: top-level dirs under `~/.dither/entries/` are the only qmd collections; nesting under them is filesystem-only and falls out of qmd's default `**/*.md` recursive glob. Dither grants are independently globs over the *full* path identifier (`messages`, `messages/tom`, `messages/**`, etc.), enforced exclusively at promote. The two layers are decoupled. Subtree-scoped search (Model C's `--scope` flag) is a future concern; we keep `dither search --collection messages` as "the whole subtree" by virtue of qmd's recursive glob.
- **Grant globs do not include the `.md` extension.** Dither only deals with markdown; the path identifier is the directory path with no file suffix.

## Out of scope (split into a sibling spec)

- Default-interactive `dither plugin run` / `install` with `--accept-defaults` and missing-with-no-default error in non-interactive mode. Applies symmetrically to env, files, and collections — belongs in its own spec on top of this one.
