# Plan: search-preview

> Source spec: `specs/search-preview.md`

## Architectural decisions

- **Public API shape**: `SearchOptions` gains `preview?: boolean`; `SearchHit` gains `snippet?: { text: string; line: number }`. Snippet is populated only when `preview: true` is passed. Renderer carries no ANSI in the carried `text` — highlighting is applied at print time.
- **CLI flag**: `--preview` (alias `-p`) on `dither search`, boolean, default off. Passed straight through to `search()`.
- **Snippet engine**: qmd's `extractSnippet(body, query, maxLen, chunkPos, chunkLen, intent)`. We do not pass `intent` (dither doesn't expose it). `maxLen` left at the qmd default — width-truncation happens at render time, not extraction time.
- **Body sourcing**:
  - Hybrid mode: `HybridQueryResult.body` + `bestChunkPos` are already on the result — no extra DB hit.
  - Lex mode: one `store.getDocumentBody(docid)` per hit. Bounded by `--limit` (default 10).
- **Render contract**:
  - TTY: existing one-line header row stays byte-identical; a second indented line follows when a snippet exists. Indent aligns the snippet under the `title` column (computed from `scoreW + docidW + collW + 3*gap.length`), not a fixed two-space gutter — fixes the spec's "soft spot 1".
  - Pipe (non-TTY): snippet appended as a 6th tab-separated column after `title`. No truncation. No ANSI.
- **Highlight + width**:
  - Whole-word, case-insensitive match of every whitespace-tokenized query term, bolded via `picocolors.bold`. Surrounding text dimmed via `picocolors.dim`.
  - Width budget = `process.stdout.columns ?? 80` minus the title-column indent. Ellipsis (`…`) on either side when the visible match isn't at the start/end. Single physical line.
  - `picocolors.isColorSupported === false` (covers `NO_COLOR`, dumb terminals) → no ANSI escapes; snippet text rendered plain.
- **Failure mode**: any per-hit snippet failure (missing body, qmd throw, empty body) is swallowed; the hit's header still prints, snippet line is omitted. Search itself never fails because preview did.
- **Out of plan**: any redesign of the header row, persisted preview config, `dither get --line` line-jumping. `snippet.line` is wired through the API for future use only.

---

## Phase 1: Tracer — `--preview` end-to-end, lex mode, plain text

**User stories**: 1, 4, 5 (partial).

End-to-end: `dither search "auth" --mode lex --preview` returns hits, and each hit prints an extra indented line containing a snippet drawn from the matched region of the body. Piped output keeps one row per hit and appends the snippet as a tab-separated column. No highlighting, no width truncation, no color logic yet — just the plumbing and the layout shape.

**Acceptance:**
- [ ] `SearchOptions` in `packages/cli/src/search.ts` declares `preview?: boolean`.
- [ ] `SearchHit` declares `snippet?: { text: string; line: number }`.
- [ ] When `preview: true` and `mode: "lex"`, `search()` calls `store.getDocumentBody(docid)` per hit, runs `extractSnippet(body, query, …, chunkPos)`, attaches `{ text, line }`. Per-hit error → snippet omitted, hit still returned.
- [ ] `searchCommand` in `packages/cli/src/commands/search.ts` registers `preview` (boolean, alias `p`) and forwards it to `search()`.
- [ ] TTY render: when a hit has a snippet, a second line prints under the header, indented to align under the `title` column. Plain text (no bold/dim yet).
- [ ] Pipe render: when a snippet exists, it's appended as the 6th tab-separated field. One row per hit.
- [ ] Test (in `packages/cli/src/search.test.ts` pattern): with `preview: true, mode: "lex"`, returned hits include a snippet whose text contains a query term; with `preview: false` (or omitted), `snippet` is undefined on every hit.

---

## Phase 2: Hybrid mode previews

**User stories**: 5, 7.

End-to-end: `--preview` also works without `--mode lex`. In hybrid mode `search()` uses `HybridQueryResult.body` + `bestChunkPos` directly — no extra DB lookup — so the snippet sits inside the chunk the reranker actually picked.

**Acceptance:**
- [ ] In hybrid branch of `search()`, when `preview: true`, feed `r.body` + `r.bestChunkPos` (and `r.bestChunk.length` for `chunkLen`) into `extractSnippet`. Attach result to `SearchHit.snippet`.
- [ ] No new DB calls in the hybrid path.
- [ ] Test: hybrid-mode preview returns a snippet whose `line` matches the chunk region (or, if model load is too slow for CI, skipped under the existing CI-skip env var pattern used elsewhere).
- [ ] Manual smoke: `dither search "<query>" --preview` (default hybrid) shows snippet lines.

---

## Phase 3: Highlight + width truncation + NO_COLOR

**User stories**: 2, 3, 8.

End-to-end: snippet line is visually distinct (dim surrounding text, bold query terms), clipped to terminal width with leading/trailing ellipses, and degrades cleanly when color is disabled.

**Acceptance:**
- [ ] Render path in `printHits` highlights every whole-word, case-insensitive occurrence of every whitespace-tokenized query term with `picocolors.bold`; surrounding snippet text is `picocolors.dim`.
- [ ] Width budget = `process.stdout.columns ?? 80` minus the title-column indent. Snippet truncated to one physical line. Leading `…` when match isn't at line start; trailing `…` when text is clipped on the right.
- [ ] When `picocolors.isColorSupported === false`, snippet renders plain text — no ANSI bytes, but ellipses still used.
- [ ] Test: forcing a narrow `columns` value yields a truncated single-line snippet with `…`. Test: `NO_COLOR=1` (or `picocolors.isColorSupported` shimmed false) produces a preview line containing no ANSI escape bytes.
- [ ] Pipe (non-TTY) output remains untouched by all of the above.

---

## Phase 4: Edge-case hardening

**User stories**: 6.

End-to-end: missing or empty body for one hit doesn't break the rest of the result list; a query made entirely of stopwords still yields a usable snippet (start-of-chunk fallback). Both behaviors covered by tests.

**Acceptance:**
- [ ] In lex branch: `getDocumentBody` returning `null`/empty → `snippet` is omitted for that hit; hit is still returned with header info. No throw.
- [ ] In hybrid branch: empty `body` or `bestChunk` → same fallback (omit snippet).
- [ ] When `extractSnippet` produces an empty snippet for non-empty body (no query-term matches in chunk), fall back to the first non-empty line of `bestChunk` (hybrid) or `body` (lex). Width truncation still applied.
- [ ] Test: a hit whose body has been deleted from disk still appears in results with `snippet` undefined; the header still renders in TTY mode.
- [ ] Test: a query made of stopwords against a populated index returns hits with a snippet (the fallback line), not undefined.

---

## Phase log

When starting implementation, rename this file to `./plans/search-preview-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. If git is available, stage and commit only that phase's changes after finishing, then continue to the next phase on your own. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/search-preview.md`.

| commit | summary |
|--------|---------|
|        |         |
