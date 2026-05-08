---
status: thinking
priority: P2
---

# Relationships between entries — storage shape, indexing

Sparked by url-scraper: a scraped page is the content, but the *interesting*
fact is which other entries (tweets, DMs, RSS items, ...) referenced it.
Today dither has no first-class relationship concept — every entry is an
island except for ad-hoc frontmatter pointers like `dither_parent_id`.

## Where could relationships live?

### (1) In the entry's frontmatter (current ad-hoc shape)

`dither_parent_id: ["abc123", "def456"]` on the scraped entry.
- ✅ Entry is self-describing — no extra files to keep in sync.
- ✅ Survives moves, renames, library copies.
- ❌ Mutating it without rewriting the body needs a `patchEntry()` API
  we don't have (see `notes/plugin-api-update-entry.md`).
- ❌ Reverse lookup ("which scraped entries does *this* tweet have?") needs
  a full library scan — no index.
- ❌ Frontmatter is unstructured strings — typing relationships (parent vs
  citation vs reply vs has-attachment) only by convention.

### (2) Separate relationship file alongside each entry

`twitter/likes/2026/foo.md` + `twitter/likes/2026/foo.relations.json`.
- ✅ Entry body untouched on relationship updates.
- ❌ Two files to keep consistent — moves/renames break easily.
- ❌ Doubles inode count and clutters the library.
- ❌ Same indexing problem as (1).

### (3) Centralized relationship store

`~/.dither/relations/relations.sqlite` (or `relations.ndjson`):

```sql
CREATE TABLE relations (
  src_id   TEXT NOT NULL,   -- entry id of the source side
  dst_id   TEXT NOT NULL,   -- entry id of the destination side
  kind     TEXT NOT NULL,   -- 'parent_of_scrape', 'reply_to', 'cites', ...
  meta     JSON,            -- per-kind extra data
  src_path TEXT,            -- collection-relative source path (cached, denormalized)
  dst_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_rel_src  ON relations(src_id, kind);
CREATE INDEX idx_rel_dst  ON relations(dst_id, kind);
CREATE INDEX idx_rel_kind ON relations(kind);
```

- ✅ Fast bidirectional lookup with two indexes.
- ✅ Typed (`kind`).
- ✅ No frontmatter mutation needed — append-only writes.
- ❌ Library is no longer fully self-describing. If you copy `~/.dither/library`
  to another machine without `relations/`, the relationships are gone.
- ❌ Index drift: if entries get deleted/renamed, the relations need
  garbage-collection.
- ❌ Plugin API surface grows: `addRelation()`, `removeRelation()`, query API.

### (4) Hybrid

- Source of truth lives **in frontmatter** (per (1)) — library stays
  self-describing.
- A derived **relations index** at `~/.dither/index/relations.sqlite` is
  rebuilt from frontmatter during `dither index update`.
- Reads go through the index for speed; writes go through frontmatter (which
  needs `patchEntry()`).
- Drift is fixed by re-indexing — same model qmd already uses.

This is the most consistent with how dither already works (qmd as the read
index, library as the truth). It still needs `patchEntry()` for additive
updates, and it still needs schema/conventions for relationship kinds.

## Relationship kinds we'll likely want

A short, opinionated taxonomy beats a generic graph:

- `scrape_of` — scraped entry → parent that referenced the URL
  (the immediate motivator).
- `reply_to` — reply tweet → original; iMessage reply → original.
- `quote_of` — quote-tweet, retweet-with-comment.
- `attachment_of` — attachment file → message it was sent in.
- `derived_from` — generic catch-all for plugin-produced enrichments
  (transcription of a video, OCR of an image, summary of an article).
- `cites` — body contains a link to another entry's URL or external URL
  that resolves to one.
- `same_thing_as` — manual user-asserted equivalence (deduplication).

Each kind defines:
- Cardinality (one-to-many, many-to-many).
- Whether it's plugin-asserted vs user-asserted vs auto-derived.
- What `meta` it carries (e.g. `cites` might carry the URL; `attachment_of`
  the offset within the message).

## Indexing — what queries do we need?

- "Show me all entries that scraped `https://example.com/foo`" — by URL or
  scraped-entry id, list parents.
- "Show me everything that referenced this tweet" — by tweet id, list children
  (replies, scrapes, summaries).
- "Show me the conversation thread containing this message" — recursive
  `reply_to` walk, bounded.
- "What entries derive from this YouTube video?" — by source entry, list
  `derived_from` children.

The two-index sqlite shape (idx_rel_src, idx_rel_dst) covers all of these
in O(log n + k) per query, where k is the number of matched relations.
Recursive walks need a CTE — sqlite handles that fine.

For search-time integration: when `qmd` returns a hit, dither could
optionally enrich the result with related entries via the relations index.
This is interesting but a layer above the storage decision.

## Where this collides with qmd

qmd already maintains its own document hashing + chunking + vector index. A
relations index would be a *separate* sqlite (different concerns: qmd is
content-search, relations is link-graph). They share the entry id space but
otherwise are decoupled. No need to fold relations into qmd.

## What this needs from the plugin SDK

- `addRelation({ src_id, dst_id, kind, meta? })` — plugin emits relation
  edges as part of its run. Host validates `src` or `dst` is owned by the
  plugin (writes to the central index, no frontmatter touched).
- `getRelations({ src_id?, dst_id?, kind? })` — read-side. Question: should
  plugins even be able to read relations, or just write them? The url-scraper
  wants to know "does this URL already have a scraped entry?" — answerable
  via either a plugin-private state cache (today) or a relations query.
- If we go with shape (4), we'd *also* need `patchEntry()` for the
  source-of-truth frontmatter update.

## Open questions

- Is the source-of-truth frontmatter (shape 4) worth the consistency cost?
  Or do we accept the library is *not* fully self-describing and put truth
  in a sidecar (shape 3)? The dither philosophy seems to lean self-describing,
  but every relationship-heavy system that tried to keep relations in
  frontmatter has eventually moved them out.
- Should "external URL" be a first-class node in the relation graph, or only
  internal entry ids? URL-scraper produces a synthetic entry per URL anyway,
  so this might be moot — every URL is *some* entry id.
- Versioning of relation kinds — what happens when we rename `scrape_of` to
  `scraped_from`? Migration in `dither index update`?
- Manual relations (user-asserted `same_thing_as`) — how does the user assert
  them via the CLI? `d link <id1> <id2> --kind same_thing_as`?

## Proposed next steps

- This stays a thinking note for now; relationships are too cross-cutting to
  decide alongside the test.local url-scraper.
- After url-scraper validates dedupe-by-URL in practice, revisit:
  the choice between (1) frontmatter lists + `patchEntry` and (4) the
  hybrid index will be much clearer once we've felt the friction of the
  shape we picked.
- A "relationship store" spec is a P1-after-url-scraper item.
