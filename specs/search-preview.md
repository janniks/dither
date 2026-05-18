# search --preview

## Problem Statement

`dither search` shows score, docid, collection, title — but nothing about *why*
each hit matched. To decide whether a result is worth opening, the user has to
follow up with `dither get`. The marketing copy on the homepage already shows
an inline excerpt under each hit (`...recency should decay by query intent...`);
the actual CLI doesn't.

## Solution

A new `--preview` (alias `-p`) flag on `dither search`. When set, each hit
renders a second indented line containing a one-line snippet drawn from the
matched region of the document, with the query terms visually emphasized and
the line truncated to fit the terminal width.

Default behaviour (no flag) is unchanged: a single line per hit, identical to
today's layout. The piped (non-TTY) format remains stable and grep-friendly.

## User Stories

1. As a dither user scanning results, I want a one-line excerpt under each
   hit, so that I can judge relevance without opening the file.
2. As a dither user, I want the matched query terms highlighted inside the
   excerpt, so that I can immediately see why a hit ranked where it did.
3. As a dither user on a narrow terminal, I want the excerpt clipped to the
   terminal width with leading/trailing ellipses, so that the output doesn't
   wrap and break the result layout.
4. As a dither user piping results into another tool, I want preview snippets
   appended as an extra tab-separated column (rather than inserted as new
   lines), so that my line-oriented scripts continue to work.
5. As a dither user, I want `--preview` to work with both `--mode hybrid` and
   `--mode lex`, so that previews are not tied to a particular search backend.
6. As a dither user, I want hits without a usable body (missing file, empty
   document) to still render the normal header line and just omit the
   preview, so that one bad hit doesn't break the whole list.
7. As a dither user with `--rerank`, I want the snippet to come from the
   chunk the reranker actually picked, so that the preview matches the
   ranked reason.
8. As a dither user, I want `--no-color` / `NO_COLOR` to suppress the
   highlight styling but keep the snippet text, so that the feature is
   accessible in dumb terminals and CI logs.

## Implementation Decisions

### Modules

- **`packages/cli/src/search.ts`** (`SearchHit`, `search()`)
  - Add `preview?: boolean` to `SearchOptions`.
  - Extend `SearchHit` with `snippet?: { text: string; line: number }` —
    populated only when `preview` is set.
  - For `hybrid` mode: feed qmd's `HybridQueryResult.body` +
    `HybridQueryResult.bestChunkPos` into `extractSnippet(body, query, maxLen,
    chunkPos, chunkLen)`. `bestChunkPos` ensures the snippet sits inside the
    chunk the reranker chose.
  - For `lex` mode: call `store.getDocumentBody(docid)` per hit, then
    `extractSnippet` with the `chunkPos` from `SearchResult`. The body is
    already in the same SQLite the search just queried, so this is cheap.
  - On any per-hit error (missing body, snippet extraction failure), drop
    the snippet for that hit and continue; do not throw.

- **`packages/cli/src/commands/search.ts`** (`searchCommand`, `printHits`)
  - Register `preview` arg (boolean, alias `p`).
  - Pass `preview` through to `search()`.
  - TTY render: keep today's header row exactly as-is. When `preview` is set
    and the hit has a snippet, render a second line indented under the
    header. Use the same column budget logic as today; final visible width is
    `process.stdout.columns ?? 80`.
  - Piped render: when `preview` is set, append the snippet as an additional
    tab-separated column at the end of the existing row (after `title`). Do
    not insert extra lines — one row per hit must hold.

### Snippet rendering rules (TTY)

- One physical line, never wraps. Width budget = terminal columns minus the
  indent (a fixed two-space `  ` indent under the header row).
- Body produced by `extractSnippet` is multi-line; the renderer joins lines
  with a single space, collapses runs of whitespace, then truncates with a
  unicode ellipsis (`…`) on either side when the match isn't at the start.
- Query terms (whole-word, case-insensitive, after tokenizing the raw query
  on whitespace) are bolded. Use `picocolors.bold`. The surrounding snippet
  text is dimmed (`picocolors.dim`) to keep the hit header visually dominant.
- When stdout is not a TTY *or* `picocolors` reports `isColorSupported ===
  false`, emphasis falls away (text only). No ANSI escapes.

### Edge cases

- Body lookup fails (file moved, empty body) → snippet line omitted, header
  printed normally.
- Query contains no extractable terms (e.g. all stopwords) → fall back to
  the start of `bestChunk` for hybrid, or the first non-empty line of the
  body for lex.
- Snippet shorter than width budget → render as-is, no padding.
- Snippet wider than budget → middle/right-truncate, never left-pad with
  ellipsis when the match is already at the line start.

### Width / wrap policy

- Width is read once at render time from `process.stdout.columns`.
- We do not stream/redraw on `SIGWINCH`; results are a one-shot print.
- For piped output, columns are undefined — we deliberately *don't* truncate
  in pipe mode (the consumer decides).

### API contract for SearchHit

```ts
interface SearchHit {
  path: string;
  collection: string;
  docid: string;
  title: string;
  score: number;
  snippet?: { text: string; line: number };
}
```

`snippet.text` is the post-truncation single-line string *without* ANSI
codes (highlighting is applied at render time in `printHits`). `snippet.line`
is the 1-based line number in the source file for future use (e.g. `dither
get --line`). The field is undefined unless `preview: true` was passed.

## Testing Decisions

- Good tests for this feature observe **rendered output**, not internal
  call shapes. The unit under test is "given a populated index and a query
  with `--preview`, the output contains a header line and a preview line
  with the matched terms inside".
- Tests live alongside `search.test.ts` (already wires a temp `DITHER_DIR`,
  writes markdown into a collection, calls `updateIndex()` then `search()`).
  The existing prior art is the right pattern — same fixture style, no
  mocks of qmd. Cf. `packages/cli/src/search.test.ts`.
- Cases to cover at the `search()` (library) level:
  1. `preview: true, mode: "lex"` returns hits with a populated `snippet`
     whose `text` contains a query term.
  2. `preview: true, mode: "hybrid"` ditto (skipped under
     `process.env.CI_SKIP_QMD_MODELS` if model load is too slow for CI).
  3. `preview: false` (or omitted) leaves `snippet` undefined on every hit.
  4. A hit whose body cannot be loaded still returns successfully with
     `snippet` undefined.
- Cases to cover at the `printHits` / command level (capture stdout via the
  existing `captureLogs` pattern from `init.test.ts`):
  5. TTY output (`process.stdout.isTTY` forced true) with `--preview` prints
     two lines per hit; the second line starts with two-space indent.
  6. Piped output (`isTTY` false) with `--preview` keeps one line per hit
     and the snippet is the last tab-separated field.
  7. Snippet wider than a small forced width is truncated with `…`.
  8. `NO_COLOR=1` produces a preview line containing no ANSI escape bytes.

## Out of Scope

- Multi-line snippets / code-fence aware rendering. The preview is one line.
- Reading or jumping to the matched line in `dither get` (`snippet.line` is
  carried in the API for future use but not consumed yet).
- Configurable indent, separator character, or snippet length via flag —
  there's exactly one rendering, tuned to terminal width.
- A persistent `preview = true` config setting. The default stays opt-in
  until the rendering has burnt-in across enough use.
- Reranker-aware highlighting (highlighting only the reranker-chosen sub-
  span). Today we highlight every occurrence of every query term in the
  chosen chunk.
- Changing the existing header row layout (path-first vs score-first, etc.)
  — the marketing mock shows a multi-line per-hit shape that's a larger
  redesign and tracked separately.

## Further Notes

- `@tobilu/qmd` already exports `extractSnippet(body, query, maxLen,
  chunkPos, chunkLen, intent)` with intent-weighted scoring. We pass the
  query string directly; we do not pass `intent` (dither doesn't expose
  intent on the search command today).
- For hybrid mode the body is already returned on `HybridQueryResult`, so
  preview adds no extra DB round-trips. Lex mode pays one
  `getDocumentBody(docid)` per hit, bounded by `--limit` (default 10).
- Highlight strategy is intentionally dumb (substring/word match against
  the raw query). The reranker's notion of "why this matched" is not
  exposed by qmd; we don't try to reconstruct it.
- The marketing tab in `docs/app/(home)/marketing/terminal-tabs.tsx` shows
  a richer per-hit layout (path, relative time, snippet). The CLI's
  minimum-viable version of that is just the snippet line added under
  today's row; alignment with the marketing layout can come later.
