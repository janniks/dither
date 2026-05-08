---
priority: P1
---

# Embedding search via dither (reuse qmd)

Today dither's `index update` only runs qmd's `store.update()` → BM25/FTS5 only.
`content_vectors` + `vectors_vec` tables stay empty, so hybrid mode silently
collapses to lex. We want true vector search wired through dither, reusing as
much of qmd as possible — no parallel embedding stack.

## What's missing

- No CLI surface or daemon hook calls `store.embed()` after promote.
- `dither index update` doesn't have an `--embed` flag.
- Search defaults to `hybrid` but with empty vectors that's identical to lex.

## Sketch

- Add `store.embed({ onProgress })` call after `store.update()` in
  `packages/cli/src/update-index.ts` (or behind a flag, since first embed
  downloads ~2GB of GGUF models).
- Either: `dither index update --embed` flag, or split into
  `dither index embed` subcommand mirroring qmd's surface.
- Daemon: after promote → update → optionally embed (incremental; qmd's
  `embed()` already skips chunks whose hash hasn't changed unless `force`).
- Surface model-download progress through the existing progress channel so
  first run isn't a silent ~minute stall.
- Consider `QMD_EMBED_MODEL` passthrough so multilingual users (CJK) can
  swap in Qwen3-Embedding without forking.

## Open questions

- Do we want embedding on by default, or opt-in (model download cost)?
- Where do reranker + query-expansion models fit — same opt-in or separate?
- Does the daemon embed in foreground (blocking next promote) or queue?

## Appendix: frontmatter is not separately indexed

Investigated 2026-05-08. Relevant to embedding/search quality because frontmatter
flows into both FTS and embeddings as opaque text.

How qmd handles frontmatter today:

- qmd never parses YAML. `store.js:892` reads the whole file as utf-8 and stores
  it under `content.doc` keyed by hash. Only dither parses frontmatter
  (`gray-matter` in `plugin-run.ts:109`/`:132`) — and only at promote time, for
  validation.
- FTS5 vtable has three columns: `filepath, title, body` (`store.js:660-663`).
  The trigger feeds the **entire `content.doc` blob — frontmatter + body — into
  `body`** (`store.js:670-676`). YAML tokens like `tags: [pr, dither]` are
  indistinguishable from prose under porter+unicode61.
- `documents.title` is filled by `extractTitle` (`store.js:1445-1477`), which
  scans for `^##?\s+` in the body. **A `title:` in frontmatter is ignored** —
  falls back to filename basename. Contradicts docs that suggest emitting
  `title:` (`docs/.../authoring.mdx:376`).
- `store.embed()` chunks `doc.body` (full file incl. frontmatter,
  `store.js:1051`) with no strip. The chunker's hr-break regex matches the
  closing `---` but not the opening one (needs leading `\n`), so frontmatter
  typically lands inside the first chunk mixed with body.
- No frontmatter table, no key/value index, nothing queryable beyond
  `collection` + the FTS columns. Spec language like "indexable via qmd
  metadata search" (`specs/imessage-plugin.md:155`) is aspirational — only FTS
  over raw YAML exists.

### Why this matters for search quality

- Every entry's frontmatter dilutes FTS scoring and consumes embedding-chunk
  space with no semantic weighting. URLs, ids, timestamps in YAML pollute
  vectors.
- No way to filter-by-tag, range-by-date, or scope-by-source without grepping
  FTS — and that collides with body prose.
- Frontmatter `title:` is silently dropped from `documents.title`, so
  title-weighted ranking misses plugin-emitted titles.

### What a real fix would need

Additional indices, in rough priority order:

- **Structured key/value index**: a `frontmatter(doc_id, key, value)` table or
  per-key columns on `documents` for the well-known fields (`tags`,
  `external_id`, `external_url`, `created`, `source`, `kind`). Enables
  `WHERE tag = ? / created BETWEEN ? AND ?` filters as a pre-filter before
  FTS/vector.
- **Tag index** specifically — unnested array → `doc_tags(doc_id, tag)` for
  fast `IN`/`AND` set ops. Tags are the most-requested filter facet.
- **Title promotion from frontmatter**: fix `extractTitle` to prefer
  `title:` frontmatter over the H1 scan, or have dither write the resolved
  title to `documents.title` directly.
- **Frontmatter strip before embedding**: chunk the body only, or embed
  frontmatter as a separate "metadata chunk" with a distinct vector — so
  YAML noise doesn't dominate the first chunk's vector.
- **FTS field for frontmatter** (lower priority): a fourth FTS column
  `frontmatter` so MATCH queries can target metadata vs body explicitly.

Trade-off: every additional index is more state qmd has to maintain on
update/embed and another contract to keep stable across qmd versions. The
key/value table is the single highest-leverage addition; everything else is
incremental.
