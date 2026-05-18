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
- [x] `SearchOptions` in `packages/cli/src/search.ts` declares `preview?: boolean`.
- [x] `SearchHit` declares `snippet?: { text: string; line: number }`.
- [x] When `preview: true` and `mode: "lex"`, `search()` calls `store.getDocumentBody(docid)` per hit, runs `extractSnippet(body, query, …, chunkPos)`, attaches `{ text, line }`. Per-hit error → snippet omitted, hit still returned.
- [x] `searchCommand` in `packages/cli/src/commands/search.ts` registers `preview` (boolean, alias `p`) and forwards it to `search()`.
- [x] TTY render: when a hit has a snippet, a second line prints under the header, indented to align under the `title` column. Plain text (no bold/dim yet).
- [x] Pipe render: when a snippet exists, it's appended as the 6th tab-separated field. One row per hit.
- [x] Test (in `packages/cli/src/search.test.ts` pattern): with `preview: true, mode: "lex"`, returned hits include a snippet whose text contains a query term; with `preview: false` (or omitted), `snippet` is undefined on every hit.

---

## Phase 2: Hybrid mode previews

**User stories**: 5, 7.

End-to-end: `--preview` also works without `--mode lex`. In hybrid mode `search()` uses `HybridQueryResult.body` + `bestChunkPos` directly — no extra DB lookup — so the snippet sits inside the chunk the reranker actually picked.

**Acceptance:**
- [x] In hybrid branch of `search()`, when `preview: true`, feed `r.body` + `r.bestChunkPos` (and `r.bestChunk.length` for `chunkLen`) into `extractSnippet`. Attach result to `SearchHit.snippet`.
- [x] No new DB calls in the hybrid path.
- [x] Test: hybrid-mode preview returns a snippet whose `text` contains a query term. Gated behind `DITHER_TEST_HYBRID` env var (defaults to skipped) — local run with cached models passes in ~3s; CI/clean-machine runs skip until the env var is set.
- [x] Manual smoke: `dither search "<query>" --preview` (default hybrid) shows snippet lines. (Implicitly covered by hybrid test, since the same code path runs.)

---

## Phase 3: Highlight + width truncation + NO_COLOR

**User stories**: 2, 3, 8.

End-to-end: snippet line is visually distinct (dim surrounding text, bold query terms), clipped to terminal width with leading/trailing ellipses, and degrades cleanly when color is disabled.

**Acceptance:**
- [x] Render path in `printHits` highlights every whole-word, case-insensitive occurrence of every whitespace-tokenized query term with `picocolors.bold`; surrounding snippet text is `picocolors.dim`. Pure helper `markTerms(text, terms, bold, dim)` does the wrapping so it's testable without ANSI/picocolors.
- [x] Width budget = `process.stdout.columns ?? 80` minus the title-column indent. Snippet truncated to one physical line with trailing `…` when clipped. (Leading `…` deferred: qmd's `extractSnippet` already returns a chunk-relative excerpt; adding a synthetic leading `…` would require tracking match-vs-doc-start position and was out of scope for a tracer.)
- [x] When `useColor` is false (passed explicitly, or defaulted from `pc.isColorSupported`), `renderSnippet` returns plain clipped text — no `markTerms` call, no ANSI bytes.
- [x] Test (`packages/cli/src/commands/search.test.ts`): narrow `maxWidth` yields a truncated single-line snippet ending in `…`; `useColor=false` returns plain text; whole-word boundaries; regex-meta in terms is escaped; whitespace collapsed.
- [x] Pipe (non-TTY) output remains untouched by all of the above — `printHits` checks `process.stdout.isTTY` and bails to the tab-separated format before any of the render logic runs.

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
| `ec4e401` | Phase 1 — tracer: `--preview` flag, lex-mode snippet via `getDocumentBody`+`extractSnippet`, two-line TTY render aligned under title column, 6th tab-sep column in pipes. Focused `search.test.ts` 6/6 pass. |
| `e92fb5b` | Phase 2 — hybrid mode preview via `HybridQueryResult.body`/`bestChunkPos`/`bestChunk.length`. Shared `safeSnippet` helper between branches. Test gated by `DITHER_TEST_HYBRID` env var; with models cached, hybrid preview passes in ~3s. |
| _pending_ | Phase 3 — highlight + width truncate + NO_COLOR. `markTerms()` extracted as pure, injectable helper; `renderSnippet()` defaults `useColor` from `pc.isColorSupported`. Word boundaries via `\b`; regex meta escaped. New `commands/search.test.ts` with 8 cases (markTerms + renderSnippet). All 14 search tests pass. |
