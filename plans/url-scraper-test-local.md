# Plan: URL scraper — test.local validation

> Source spec: `specs/url-scraper-test-local.md`

## Architectural decisions

- **Plugin location**: `test.local/plugins/url-scraper-test/` (main plugin) and
  `test.local/plugins/dom-smoke/` (precursor DOM-library probe).
- **Manifest** (main plugin):
  - `env`: `MAX_URLS` (testing cap, empty = none), `TIMEOUT_MS` (default
    15000), `USER_AGENT` (default `dither-url-scraper-test/0.1`).
  - `files`: `SOURCE` — folder grant, required.
  - `net`: `["*"]` — wildcard. Relies on host honoring this as bare
    `--allow-net=*` (precondition, tracked elsewhere).
  - `collections`: `["urls/**"]`.
  - No `watch`, no `schedule`.
- **Output entry**: `urls/<host>/<sha1(source_url).slice(0,12)>.md`.
  - Frontmatter: `id`, `kind: url-scrape`, `source_url`, `final_url`,
    `status`, `content_type`, `fetched_at`, `title`, `byline`, `excerpt`,
    `site_name`, `dither_parent_id` (list), `dither_parent_path` (list),
    `source`, `collection`.
  - Body: `article_text` from Readability (or empty for non-HTML).
- **State schema** (`state.json`):
  ```json
  { "schema_version": 1,
    "scrapes": { "<source_url>": { "fetched_at": "...", "status": 200,
                                    "final_url": "..." } } }
  ```
- **Cache decision**: 2xx → skip; 4xx → permanent skip; 5xx / network → retry.
  No ETag / Last-Modified / MAX_AGE / REFRESH.
- **Module split**: `extract.ts` (DOM + Readability behind one function),
  `render.ts` (pure transform), `cache.ts` (state schema + decide rules),
  `plugin.ts` (orchestrator: walk, parse frontmatter, dedupe, pace, fetch,
  extract, render, write, save state).
- **DOM library**: TBD by Phase 1 smoke test. Try `jsdom` → `linkedom` →
  `cheerio` → `parse5` (per project npm-security rule: well-known, no
  release in last 7 days). All callers go through `extract()` so swaps are
  one-file changes.
- **Pacing**: per-host serialization, `MIN_DELAY_MS=1000` hardcoded; module-
  level `Map<host, lastFetchAt>` + `paceHost(host)` helper. Sequential
  globally — no `MAX_CONCURRENCY`.
- **Tooling**: plain async/await. No Effect-TS. No try/catch in the pure
  transforms.
- **Known v1 limitations** (deliberate): new-parent-on-already-scraped-URL
  is logged but not appended to the existing entry's `dither_parent_id`
  (`patchEntry()` SDK gap, see `notes/plugin-api-update-entry.md`); no
  retry/backoff within a run; no URL canonicalization; no robots.txt.

---

## Phase 1: DOM library smoke test

**User stories**: 1, 2, 3.

A throwaway probe plugin (`test.local/plugins/dom-smoke/`) that imports a
candidate DOM library, parses a hardcoded HTML string with a known title,
and emits the parsed title via `progress()`. We try libraries in order and
record which one loads cleanly under `--allow-env=DITHER_*`. The chosen
library becomes the dependency of `extract.ts` in Phase 2.

**Acceptance:**
- [x] Smoke plugin installs and runs against `test.local/.dither`.
- [x] At least one of `jsdom` / `linkedom` / `cheerio` / `parse5` loads
      without an import-time `process.env` (or other sandbox) error.
- [x] Plugin output prints the title extracted from the hardcoded HTML.
- [x] Phase log records the winning library and any sandbox quirks
      observed (e.g. extra `--allow-*` needed, missing globals).

**Outcome:** `linkedom` + `@mozilla/readability`. `jsdom` crashed at import
via its `debug` transitive dep (`Object.keys(process.env)`). `linkedom` is
a smaller pure-JS polyfill, loads clean, and Readability runs against its
`Document` without modification. Synthetic article: title and textContent
extracted; `byline` detection didn't fire on the synthetic markup
(Readability looks for specific class patterns) — flag for Phase 4
real-subset evaluation.

---

## Phase 2: Tracer scraper — synthetic fixture, end-to-end with pacing

**User stories**: 4, 5, 8, 9, 12, 13, 16.

Build the four-file plugin against a synthetic SOURCE fixture only — no
real twitter data yet. Walks SOURCE, parses frontmatter, dedupes URLs
across parents within the run, fetches sequentially with per-host pacing
(`MIN_DELAY_MS=1000`), runs `extract()` on HTML responses, renders one
entry per unique URL under `urls/<host>/<hash>.md`, writes via the SDK.
`MAX_URLS` cap honored. No cache yet — every run re-fetches.

**Synthetic fixture**: a few hand-crafted source entries under
`test.local/.dither/library/test-source/` linking `https://example.com`,
`https://httpbin.org/html`, `https://httpbin.org/redirect-to?url=https://example.com`,
and `https://httpbin.org/status/404`. Marked `source: test-fixture` so the
scraper doesn't refuse them.

**Acceptance:**
- [x] Synthetic fixture exists and validates as real dither entries.
- [x] Plugin installs with `--file SOURCE=...` and `net: ["*"]` honored.
- [x] `d plugin run url-scraper-test --env MAX_URLS=5` produces one
      `urls/<host>/<hash>.md` entry per successful (2xx) URL.
- [x] Two source entries linking the same URL produce one scraped entry
      with both parents in `dither_parent_id` (within the run).
- [x] Run journal timestamps show ≥ 1s gaps between fetches to the same
      host.
- [x] `d index update && d search "<phrase from a known scraped page>"`
      surfaces the scraped entry.
- [x] Picking a search hit and reading frontmatter, `dither_parent_path[0]`
      points to a real source entry on disk.
- [x] 404 URL produces no entry; failure logged in plugin output.
- [x] Redirect chain results in the scraped entry's `final_url` ≠ `source_url`.

**Outcome:** Tracer scraper end-to-end against the synthetic fixture works.
4 unique URLs collected from 2 entries; example.com had 2 parents and
produced one entry with both ids in `dither_parent_id`. Redirect resolved:
source_url=`httpbin.org/redirect-to?url=…` → final_url=`https://example.com/`,
entry filed under `urls/example.com/`. Pacing visible in journal: two
same-host (httpbin.org) calls were 1.00s apart. Search hits both scraped
articles by body content (score 1.000). Side note: `--allow-net` host
extension landed in `plugin-run.ts` to honor `net: ["*"]` as bare flag
(the documented precondition).

---

## Phase 3: Cache — permanent vs transient skip

**User stories**: 6, 7, 10, 11.

Promote `cache.ts` from inline state to a module exposing `loadCache()`,
`saveCache()`, and `decide(url, cache) → "fetch" | "skip"`. Wire into
`plugin.ts` between dedupe and fetch. Re-runs become no-ops for prior 2xx;
4xx URLs stay skipped permanently; 5xx/network errors retry on the next
run. Plugin emits an end-of-run summary line: `scraped N, skipped M from
cache, X failed`.

**Acceptance:**
- [x] `state.json` matches the documented schema after a successful run.
- [x] Re-running with no SOURCE changes prints "scraped 0, skipped N from
      cache, 0 failed" and writes no new files in `urls/`.
- [x] After a synthetic 404 URL is scraped once, a second run skips it
      without a network request.
- [x] After a synthetic 5xx URL is scraped once, a second run does fetch
      it again (verify via run journal).
- [x] Deleting `state.json` causes a re-run to re-fetch every URL.
- [x] Phase log records per-branch behavior observed.

**Outcome:** `cache.ts` extracted with `decide(url, cache)` returning
`fetch` / `skip-cached` / `skip-permanent`. State persisted via SDK
readState/writeState. Verified on the synthetic fixture extended with a
`httpbin.org/status/500` URL: 2xx → skip-cached, 4xx → skip-permanent,
5xx → fetch (every run). Second run with no changes is a true no-op
("scraped 0, skipped 4 from cache, failed 0"). Deleting state.json
re-runs every URL.

---

## Phase 4: Real twitter subset + lessons

**User stories**: 14, 17, 18.

Copy ~10 random `*.md` files from
`test.local/.dither/library/twitter/likes/2026/` into the SOURCE folder,
run, and capture real-world surprises: UA-blocking, JS-rendered SPAs that
yield empty `article_text`, dead `t.co`s, mojibake, sites that time out.
Add an inline `// TODO(patchEntry)` in `plugin.ts` at the spot where a
new parent on an already-scraped URL would append to `dither_parent_id`.
Append a "Lessons captured" section to the plan log: which DOM library
won, Readability hit-rate on the real subset, observed throughput, any
failure modes the spec didn't anticipate.

**Acceptance:**
- [x] ~10 real twitter likes copied into SOURCE; `id`, `urls`, `source`
      preserved.
- [x] Run completes; failures don't crash the orchestrator.
- [x] At least one real article ends up searchable via `d search` against
      a phrase from its body.
- [x] `// TODO(patchEntry)` marker present at the new-parent-on-existing
      branch with a one-line comment pointing at the notes file.
- [x] Phase log includes the lessons section with at least: chosen DOM
      library, real-subset hit rate, throughput estimate, list of
      surprises.

### Lessons captured (real subset)

- **Chosen DOM library**: `linkedom` + `@mozilla/readability`. JSDOM blocked
  by sandbox at import time (`debug` → `Object.keys(process.env)`).
- **Real-subset hit rate**: 7 t.co URLs sampled (10 likes, 3 had no `urls:`
  frontmatter or were already in cache).
  - 5/7 (71%) resolved to `x.com/...` and got the **anti-bot block page**
    served by Twitter. Body identical across all 5: "Something went wrong,
    but don't fret — let's give it another shot. Some privacy related
    extensions may cause issues on x.com. Please disable them and try again."
    Title empty, body ~168 chars. This is the load-bearing surprise.
  - 1/7 (alfredvc.no) → real article, title="Do you even know how LLMs
    work?", body 12.2 KB. Search on "LLMs" surfaces it at score 1.000 —
    higher than the linking tweet (0.500). **Central design hypothesis
    confirmed.**
  - 1/7 (pay.sh) → marketing landing page, title + 2.1 KB body. Decent.
- **Useful-content rate**: 2/7 (29%). The shippable plugin needs an
  anti-bot detector (heuristic: empty title + body < 500 chars + matches
  known templates) to avoid storing useless "please enable JS" entries.
- **Throughput**: ~1.1s per fetch with `MIN_DELAY_MS=1000`. 8 fetches in
  ~9s wall-clock (matches the per-host 1s gap). For a 10k-like real
  library that's ≈ 2.7h — acceptable as opt-in batch, not as a
  daemon-driven sync.
- **`net: ["*"]`** is the right grant model — 7 destination hosts emerged
  from a single 8-URL run (t.co, x.com, alfredvc.no, pay.sh, plus the
  fixture's example.com and httpbin.org). A hand-curated allowlist would
  have failed before the first useful run.
- **Pacing limitation**: pacer keys on the *source* host (t.co), not the
  redirect target. With 7 t.co URLs, all redirects to x.com hit x.com
  back-to-back without any per-target delay. We didn't trigger x.com's
  rate-limiter (its anti-bot fired first), but the shippable plugin
  should pace by the post-redirect host — or at minimum apply a
  redirect-aware secondary gate.
- **Limitation confirmed**: the new-parent-on-already-scraped-URL gap is
  real but invisible during testing — none of our re-runs introduced new
  parents. Will surface only in production with new tweets that link
  already-scraped URLs.

---

## Phase 5: Unit tests for extract + render

**User stories**: 15.

Add `extract.test.ts` and `render.test.ts` next to the modules. Run with
`deno test`. `extract` tests use canned HTML strings (a paragraph-heavy
article, an OG-only page, an empty page, a mojibake page) and assert
`title`/`article_text`/`site_name` shape. `render` tests construct a
synthetic per-URL result and assert `EntryOptions.collection`, filename,
frontmatter list-typed fields, and body.

**Acceptance:**
- [x] `extract.test.ts` covers four canned-HTML cases without network.
- [x] `render.test.ts` covers two cases — single-parent and two-parent
      dedupe — and asserts the parent fields are always lists.
- [x] `deno test` runs from the plugin directory and is green.
- [x] No mocks of `fetch`; tests are pure-input/output.

**Outcome:** 11 tests, all green (4 in `extract.test.ts`, 7 in
`render.test.ts`). `extract` covers paragraph-heavy article, OG-only
landing, empty html, and utf-8 multibyte. `render` covers single-parent,
two-parent, sha1 filename, host-from-final-url collection, plus utility
helpers (`urlId`, `urlHost`, `sanitizeHost`). One small typecheck cast
needed in `extract.ts` because linkedom's `parseHTML` return type
collides with Deno's global `Window`.

---

## Phase log

When starting implementation, rename this file to
`./plans/url-scraper-test-local-RUNNING.md`. Work one phase at a time,
ticking acceptance as each criterion is satisfied. Stage and commit each
phase's changes after finishing; append a row to the log below. When all
phases complete, rename back to `./plans/url-scraper-test-local.md`.

| commit | summary |
|--------|---------|
| bcf01c5 | Phase 1: dom-smoke plugin probes DOM libs. linkedom + readability win; jsdom blocked by `debug` env probe. |
| a0ee754 | Phase 2: tracer scraper end-to-end against synthetic fixture (3 scraped + 1 4xx); dedupe with 2 parents on example.com; per-host pacing 1.00s gap; search by body content works. Includes `plugin-run.ts` change to honor `net: ["*"]` as bare `--allow-net`. |
| 406a75b | Phase 3: `cache.ts` module; permanent-vs-transient skip verified — 2xx & 4xx → skip, 5xx → retry. Second run is a true no-op. |
| 77c0bc1 | Phase 4: real twitter subset (10 likes). 5/7 hit x.com anti-bot block (load-bearing surprise). 2/7 yield real article content; "LLMs" search hits scraped alfredvc.no entry at score 1.000 over the linking tweet at 0.500. |
| (pending) | Phase 5: 11 unit tests (4 extract, 7 render). `deno test` green. Plan complete; renamed back from RUNNING. |
