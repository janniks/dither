# qmd search — collection filter applied post-rank + LLM-expansion non-determinism

Surfaced 2026-05-24 while debugging `d search andre -c slack`.

## Symptom

```
$ d search andre365 -c slack
1.000  1a3338  C08EEVC4U2D-2025-02-19    ← the mpdm doc with @andre365

$ d search andre -c slack
(empty)                                    ← first run, models cold

$ d search andre -c slack                  ← second run, same query
1.000  caa6a7  C09GG5VL9NE-2025-09-22
0.500  22b2ed  C0A1HVABZ8U-2025-12-04
0.333  e01626  C09GG5VL9NE-2025-10-01
…                                          ← different docs, andre365 is gone
```

Identical query, two different result sets on consecutive runs. The
exact-substring match (`1a3338`) doesn't surface at all in either.

## Root cause #1 — collection filter applied after pre-rank cap

qmd `store.js:searchFTS` (`tobilu/qmd` in `node_modules`):

```sql
WITH fts_matches AS (
  SELECT rowid, bm25(...) FROM documents_fts
  WHERE documents_fts MATCH ?
  ORDER BY bm25_score ASC
  LIMIT ${ftsLimit}             -- collection ? limit * 10 : limit
)
SELECT … FROM fts_matches fm
JOIN documents d ON d.id = fm.rowid
WHERE d.active = 1
  AND d.collection = ?          -- ← filter applied here, AFTER LIMIT
```

For `andre*` (the prefix form `buildFTS5Query` produces), 544 docs
globally contain a token starting with `andre`. BM25 ranks
`reader`-collection German prose (containing "andrea", "andreas", etc.)
above the slack doc. `LIMIT 200` (= 20×10) takes the top 200 globally;
slack doc is rowid 21645 and falls outside that window. The `-c slack`
filter then eliminates the surviving rows → empty.

For `andre365`: only one doc has that exact token (rare → very high
IDF), it's #1 globally, the collection filter keeps it.

## Root cause #2 — LLM query expansion is non-deterministic between runs

Default mode is hybrid, which runs an LLM query-expansion step. The
qmd `llm_cache` table caches per-query expansions. For `andre` the
cached expansion is:

```json
[
  {"type":"lex","query":"andre basics"},
  {"type":"lex","query":"andre tutorial"},
  {"type":"vec","query":"how to get started with andre"},
  {"type":"vec","query":"beginner guide to andre"},
  {"type":"hyde","query":"This guide covers the basics of andre. Follow the steps to get started with your first…"}
]
```

- **First run (models cold).** LLM hadn't loaded; expansion failed
  silently; hybrid degraded to bare BM25; the rank-200 cap above hides
  the slack doc.
- **Second run (cache populated, models warm).** All 5 expansion
  branches ran. Vector + hyde branches surface docs that are
  semantically near "tutorial about Andre" / "guide to Andre" — not the
  original `andre365` doc. RRF fuses → 5 entirely different slack docs
  bubble up. The `andre365` doc still doesn't appear because only the
  weakest leg (bare-`andre*` BM25) touches it, and that leg's rank is
  still buried.

Net effect: same query, same data, totally different output between two
consecutive runs. Documents that contain the literal substring don't
necessarily appear; documents that don't contain it can.

## Verification queries used

```sql
-- Tokenizer:
SELECT sql FROM sqlite_master WHERE name = 'documents_fts';
-- → CREATE VIRTUAL TABLE documents_fts USING fts5(filepath, title, body,
--   tokenize='porter unicode61')

-- No bare `andre` token in the index:
CREATE VIRTUAL TABLE dv USING fts5vocab(documents_fts, 'row');
SELECT term FROM dv WHERE term LIKE 'andre%';
-- → andre365, andrea, andreas, andrew, … (no "andre" alone)

-- FTS5 prefix match DOES find the slack doc — but it's deep in the rank:
SELECT count(*) FROM documents_fts WHERE documents_fts MATCH '"andre"*';
-- → 544

SELECT hash, substr(result, 1, 300) FROM llm_cache;
-- → the expansion JSON shown above
```

## Workarounds users have today

- `d search "andre*" -c slack --mode lex` — bypass hybrid, force prefix
  lex only. Still subject to root-cause #1 but no LLM noise.
- `d search andre365 -c slack` — exact rare token, deterministic.
- `d search "@andre" -c slack` — quoted phrase rewrites through
  `sanitizeFTS5Term`; phrase mode bypasses prefix but matches exact
  tokens.

## Real fix sketch (qmd-side change, not dither-side)

1. **Push collection filter into the FTS CTE.** Most important.
   Spend the 200-row pre-cap inside the requested collection, not
   across all collections:
   ```sql
   WITH fts_matches AS (
     SELECT documents_fts.rowid, bm25(...) AS bm25_score
     FROM documents_fts
     JOIN documents d ON d.id = documents_fts.rowid
     WHERE documents_fts MATCH ?
       AND d.collection = ?       -- ← inline
     ORDER BY bm25_score ASC
     LIMIT ?
   )
   ```
   Tradeoff: SQLite query planner may or may not be able to use the FTS
   index efficiently with the join in the CTE. The `*10` multiplier
   exists today specifically because of this concern; the right fix
   probably needs to verify the planner with `EXPLAIN QUERY PLAN`.

2. **Weight the original query above LLM expansions in hybrid RRF.**
   A bare-term hit should dominate vector hallucinations on the same
   doc. The current RRF treats all 5 branches as equal-weight.

3. **Skip LLM expansion when no model is loaded** rather than silently
   degrading. The first-run "empty" result with no error is confusing.

## Cross-refs

- qmd source: `packages/cli/node_modules/@tobilu/qmd/dist/store.js`
  - `buildFTS5Query` ~ line 2114
  - `searchFTS` ~ line 2218
  - `tokenize='porter unicode61'` ~ line 660
- dither side: `packages/cli/src/search.ts` (just calls
  `store.search` / `store.searchLex`; nothing to fix here)
- Reproducer db: `~/.config/dither/qmd-index.sqlite`
