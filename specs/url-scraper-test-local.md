---
status: complete
priority: P2
scope: test.local validation only — not a shippable plugin
---

# URL scraper — test.local validation spec

## Problem Statement

Entries already in dither (twitter-import likes, iMessage messages, eventually
RSS/raindrop) carry `urls: [...]` in their frontmatter, but the URLs are opaque
strings that don't contribute to search. The page text *behind* those URLs is
where the searchable substance lives. Before committing to a shippable URL
scraper plugin, we want to validate the design — described in
`specs/url-scraper-DRAFT.md` and `notes/url-scraper-plugin.md` — against real
entries in `test.local`, learning where the design holds and where it doesn't.

The reference implementation in `mmry-new/src-tauri/scripts/scrape.ts` proves
the JSDOM + Readability approach works in a Tauri/Deno context, but several
unknowns are specific to dither's plugin sandbox:

- Does JSDOM (or some equivalent) survive `--allow-env=DITHER_*`? Multiple
  npm libraries we've reached for (adm-zip, fflate, unzipper, yauzl-promise)
  crashed at import time in this sandbox.
- Does the side-collection + `dither_parent_id` shape work end-to-end —
  scraped page becomes a real entry, search hits its body, the linkback to
  the originating tweet is intact?
- Does a dedupe-by-URL cache plus per-host pacing prevent the obvious
  foot-guns (re-fetching shorteners, hammering one host) without dragging
  in the full politeness machinery?

## Solution

Build a *test.local-only* plugin (`test.local/plugins/url-scraper-test/`) that
takes a SOURCE folder grant, walks every `*.md` under it, dedupes the URLs
across all entries, fetches each unique URL once with per-host pacing, runs
Readability for the article text, and writes one entry per URL under
`urls/<host>/<sha1[:12]>.md` with `dither_parent_id` linking back to the
source entries that mentioned it.

Manual run only (`d plugin run url-scraper-test`); no `watch` block. Cache
tracks "fetched once, with status" — 4xx URLs become permanent skips, 5xx
and network errors retry on the next run. No exponential backoff, no `Retry-After`,
no ETag/304, no `MAX_AGE_DAYS`, no `REFRESH` flag. Force re-scrape by deleting
the state file.

The HTML extractor lives behind one function in `extract.ts`. If JSDOM crashes
in the sandbox we fall back to `linkedom` or `cheerio` without touching the
rest of the plugin — that's the value of pinning the boundary.

A pre-flight smoke test (~20 lines) validates the chosen DOM library *before*
we write any orchestration code, so a JSDOM-class failure can't waste plugin
work.

## User Stories

1. As a dither developer, I want to know whether `npm:jsdom` loads inside the
   plugin sandbox without an import-time `process.env` crash, so I know
   whether to keep mmry-new's tooling choice or pivot to `linkedom`.
2. As a dither developer, I want the HTML extractor exposed as one
   `extract(html, baseUrl)` function, so swapping the underlying DOM library
   touches a single file.
3. As a dither developer, I want a tiny 20-line smoke-test plugin that just
   imports the candidate DOM library, parses a hardcoded HTML string, and
   exits, so I can de-risk the library choice in isolation before the
   scraper's orchestration code is written.
4. As a dither developer running the scraper against my real twitter-import
   library, I want each unique URL fetched at most once per run, so a single
   run isn't wasted on duplicate fetches when many likes link the same article.
5. As a dither developer, I want all requests to the same host serialized
   with at least 1 second between them, so a run with 50 `t.co` URLs doesn't
   trigger Twitter's bot detection during a smoke test.
6. As a dither developer, I want a 4xx URL recorded in state and skipped on
   subsequent runs, so a dead `t.co` for a deleted account doesn't get
   re-attempted forever.
7. As a dither developer, I want a 5xx URL tried again on the next run, so
   transient outages don't permanently lose data.
8. As a dither developer, I want the scraped entry to live under
   `urls/<host>/<short-hash>.md` with `dither_parent_id` carrying the source
   entry's id, so I can navigate from a search hit on the article text back
   to the original tweet/message.
9. As a dither developer, I want `d index update && d search "<keyword from
   the article>"` to surface the scraped entry, so I have evidence the design
   actually improves search.
10. As a dither developer, I want re-running the plugin against the same
    SOURCE folder to be a no-op (modulo new entries), so the cache earns its
    keep.
11. As a dither developer, I want the plugin to print a one-line summary at
    the end ("scraped N URLs, skipped M from cache, X failed"), so I get a
    quick read on each run.
12. As a dither developer, I want the plugin scoped to a `MAX_URLS` cap so
    I can iterate on a 5-URL run without burning through my whole library
    on every iteration.
13. As a dither developer, I want a small handful of synthetic source entries
    with controlled URLs (`example.com`, `httpbin.org/html`, an intentional
    404, a redirect chain), so I can verify exact branches of the cache/skip
    logic.
14. As a dither developer, I want to also run against ~10 randomly sampled
    real twitter-likes entries, so I see real-world surprises (UA-blocking,
    SPA pages, dead t.co's, mojibake) the synthetic fixture can't reveal.
15. As a dither developer, I want pure `extract` and `render` functions I can
    cover with a handful of unit tests — feed canned HTML, assert title and
    `article_text`; pass a fake fetched record, assert the EntryOptions shape —
    so the load-bearing transforms aren't only validated by smoke runs.
16. As a dither developer, I want the plugin to declare `net: ["*"]` in its
    manifest (and the host to honor that as bare `--allow-net`), so this
    plugin doesn't need a hand-curated host allowlist that becomes stale.
17. As a dither developer aware that plugins can't currently patch a
    previously-promoted entry's frontmatter, I want a TODO marker in the
    plugin code where the "new parent for already-scraped URL" case would
    append to `dither_parent_id`, so the limitation is visible to whoever
    revisits this for the shippable version.
18. As a dither developer, I want the spec to point at `notes/plugin-api-update-entry.md`
    and `notes/relationships-and-indexes.md`, so the broader design questions
    aren't lost when we move from the test plugin to the real one.

## Implementation Decisions

### Architecture

- Plugin lives at `test.local/plugins/url-scraper-test/`, parallel to
  `imessage` and `twitter-import`.
- Three modules + the orchestrator. Four files of TypeScript total.
  - `extract.ts` — `extract(html, baseUrl) → { title, byline, excerpt,
    site_name, article_text }`. Hides the DOM library + Readability behind
    one function. The deepest module — swapping DOM libs touches only here.
  - `render.ts` — `render({ source_url, fetched, extracted, parents }) →
    EntryOptions`. Pure transform from the per-URL result struct to the
    SDK's `EntryOptions` (collection, filename, frontmatter, body).
  - `cache.ts` — exposes `loadCache()`, `saveCache(cache)`, and
    `decide(url, cache) → "fetch" | "skip"`. Encodes the schema and the
    permanent-vs-transient skip rules.
  - `plugin.ts` — orchestrator: read input, walk SOURCE, parse frontmatter,
    dedupe URLs, sequentially: cache.decide → pace → fetch → extract →
    render → writeEntry, then update cache and write summary progress.
- Pacing helper inline in `plugin.ts`: module-level `Map<host, lastFetchAt>`
  + `paceHost(host)` async function. ~5 lines.
- Frontmatter parsing inline in `plugin.ts`: each line is `key: <JSON value>`
  per dither's `writeEntry()` emission style; ~8 lines of split + JSON.parse.
- Walking SOURCE inline in `plugin.ts`: recursive readdir, filter for `*.md`.
- Fetching inline in `plugin.ts`: `globalThis.fetch()` with `AbortController`
  for `TIMEOUT_MS` and a streamed `MAX_BYTES=5_000_000` cap that aborts on
  overflow. Auto-follows redirects (default fetch behavior).

### Manifest

- `display_name`: "URL scraper (test)"
- `env`:
  - `MAX_URLS` — testing cap; empty default = no cap.
  - `TIMEOUT_MS` — per-fetch timeout; default 15000.
  - `USER_AGENT` — default `dither-url-scraper-test/0.1`.
  - `SKIP_DOMAINS` — comma-separated host list; default
    `x.com,twitter.com`. Added post-Phase-4 after observing 5/7 t.co
    URLs redirect into Twitter's anti-bot block page. Matches exact
    host or any subdomain. Applied to source URL host *and* (post-fetch)
    to `final_url` host so shorteners that redirect into a blocked host
    are dropped without producing a useless entry. Records `skipped: true`
    in the cache so subsequent runs are no-ops.
- `files`:
  - `SOURCE` — folder grant, required. Library subdir to scan.
- `net`: `["*"]` — relies on the host's wildcard support (see "Host change"
  below).
- `collections`: `["urls/**"]`.
- No `watch` block, no `schedule`.

### Output entry shape

`urls/<host>/<sha1(source_url)[:12]>.md`:

```yaml
---
id: 9f3c6b1a2c4e
kind: url-scrape
source_url: "https://t.co/abc123"
final_url: "https://github.com/foo/bar"
status: 200
content_type: "text/html; charset=utf-8"
fetched_at: "2026-05-08T11:42:00Z"
title: "foo/bar — A great repo"
byline: null
excerpt: "Short readability excerpt."
site_name: "GitHub"
dither_parent_id: ["<source entry id 1>", "<source entry id 2>"]
dither_parent_path: ["twitter/likes/2026/...", "messages/imessage/.../..."]
source: url-scraper-test
collection: urls/github.com
---

<readability article text>
```

For non-HTML responses (`content_type` doesn't start with `text/html`): emit
the entry with empty `article_text` body and the metadata still populated.
For 4xx / network errors: do not emit an entry, only update the cache.

### State / cache schema

Single `state.json` file:

```json
{
  "schema_version": 1,
  "scrapes": {
    "<source_url>": {
      "fetched_at": "ISO8601",
      "status": 200,
      "final_url": "https://github.com/foo/bar"
    }
  }
}
```

`decide(url, cache)`:
- No entry for url → `"fetch"`.
- 2xx prior → `"skip"`.
- 4xx prior → `"skip"` (permanent).
- 5xx / `status: 0` (network error) → `"fetch"` (retry).

### Host change required

The plugin manifest declares `net: ["*"]`. The host's `plugin-run.ts` needs
to honor a single-element-`"*"` net list as bare `--allow-net=*` (instead
of treating `"*"` as a literal hostname). Small edit, scoped to that one
function. **This is a precondition** for the test.local plugin to run at all
and is being tracked separately — the URL scraper spec assumes it lands.

### Smoke-test plugin (precursor)

Before any of the above, a separate ~20-line plugin
`test.local/plugins/dom-smoke/` is built and run to validate which DOM
library survives the sandbox. Order tried (per the project's npm security
rule — popular packages, no releases in the last 7 days):

1. `jsdom` — first choice (matches mmry-new).
2. `linkedom` — fallback if JSDOM crashes.
3. `cheerio` — second fallback (different parsing model — Readability won't
   work directly; would require tweaks).
4. `parse5` — last resort (lower-level, more wiring).

The smoke-test plugin imports the candidate, parses a 200-character HTML
string, and emits a `progress()` line confirming it loaded. First library
that runs without an import-time error wins. The result determines what
`extract.ts` is built against; the rest of the spec is library-agnostic.

### Known limitations (deliberate, in v1)

- **New-parent linkback is lost.** When a future run sees a URL we've already
  scraped, we cannot append the new parent to the existing scraped entry's
  `dither_parent_id` list — plugins lack both a frontmatter-patch SDK call
  and read access to their own promoted entries. The new parent is logged
  in plugin output but not persisted into the entry. Inline `// TODO` in
  `plugin.ts` marks the spot. See `notes/plugin-api-update-entry.md`.
- **No retry/backoff machinery.** A 5xx/network error retries on the next
  run, but within a single run there's no retry. Per-host failures don't
  delay other hosts.
- **No URL canonicalization.** `https://x.com/foo`, `https://x.com/foo/`,
  and `https://x.com/foo?utm=x` produce three separate scraped entries.
- **No robots.txt.** Identifying user-agent only.

## Testing Decisions

- **What makes a good test:** assert *external* behavior of the pure
  transforms — `extract(html, url) → struct` and `render(input) →
  EntryOptions` — using canned inputs. No mocks of `fetch`. Don't test the
  internal shape of state (`Map`s, walk order, etc.); test the observable
  outputs.
- **`extract.ts` tests** cover the highest-risk concern: does the chosen
  DOM library actually extract useful article content?
  - Input: a real-article HTML string saved offline (e.g. a paragraph-heavy
    blog post). Assert `article_text` length > some threshold and contains a
    known phrase from the article body, not from the nav.
  - Input: an OG-only landing page (mostly `<meta>` tags, sparse body).
    Assert `title`, `site_name` are populated; `article_text` may be short
    but non-error.
  - Input: an empty `<html></html>`. Assert all fields default to safe
    `null` / empty string and the function does not throw.
  - Input: HTML with a non-utf8 declared charset that is actually utf-8
    (the mojibake foot-gun). Assert `article_text` round-trips a known
    multi-byte string.
- **`render.ts` tests** assert the output's `collection` follows
  `urls/<host>`, the filename is the 12-char sha1 prefix, frontmatter
  contains the parent lists in the right shape (always lists, even for one
  parent), and `body` is the `article_text`.
- **`cache.ts` not formally tested** — covered by smoke runs (re-run is a
  no-op; injected 4xx URL stays skipped). If the rule set grows beyond the
  current 3-branch decide, promote to a unit test.
- **Prior art:** `imessage` and `twitter-import` plugins both have pure
  `render.ts` files; this matches that pattern. No existing plugin tests
  in the repo to mirror — this would be the first plugin-level test
  suite under `test.local/`. We can keep tests next to the plugin
  (`test.local/plugins/url-scraper-test/render.test.ts`) and run them with
  `deno test`.
- **Smoke run as integration test:** the test recipe in "Validation
  procedure" below is the integration test. Runs are reproducible and
  the state file gives a stable diff target.

## Out of Scope

- Wildcard net grant *implementation* in the host — tracked separately as a
  precondition, not part of this plugin's spec.
- `patchEntry()` SDK call — captured in `notes/plugin-api-update-entry.md`,
  out of scope here.
- Watch-fired runs.
- Concurrency above 1 (no `MAX_CONCURRENCY`, no across-host parallelism).
- Conditional GET / ETag / Last-Modified.
- Exponential backoff per host. `Retry-After` header. `MAX_AGE_DAYS`
  re-fetch policy. `REFRESH` force flag.
- Robots.txt.
- URL canonicalization / dedupe across query-string variants.
- Rendering JS-heavy SPAs (no headless browser).
- Multi-language / multilingual special-casing in extraction.
- `INCLUDE_HOSTS` allowlist filter (kept simple — `SKIP_DOMAINS` denylist
  added post-Phase-4 covers the load-bearing case).
- Removing the test.local plugin and replacing it with a shippable
  `packages/plugin-url-scraper/` — that's a follow-up spec.
- Relationship store / central index for parent lookups — see
  `notes/relationships-and-indexes.md`.

## Further Notes

### Validation procedure

1. **DOM smoke test.** Build `test.local/plugins/dom-smoke/`. Try `jsdom`
   first; if it fails, fall down the list (`linkedom` → `cheerio` →
   `parse5`). Record which library won and any sandbox-specific quirks
   discovered.
2. **Build the four files.** `extract.ts` against the chosen library;
   `render.ts`, `cache.ts`, `plugin.ts` per the implementation decisions.
3. **Synthetic fixture.** Create `test.local/.dither/library/test-source/`
   with hand-crafted entries linking `https://example.com`,
   `https://httpbin.org/html`, `https://httpbin.org/status/404`, and
   one redirect chain (e.g. `https://httpbin.org/redirect-to?url=https://example.com`).
   Mark `source: test-fixture` so the scraper doesn't refuse.
4. **Real subset.** Copy ~10 random `*.md` files from
   `test.local/.dither/library/twitter/likes/2026/` into the same
   `test-source/` folder.
5. **Install + first run.** `d plugin install ... --file SOURCE=...` then
   `d plugin run url-scraper-test --env MAX_URLS=5`. Verify each branch:
   - 200 URLs produce `urls/<host>/<hash>.md`.
   - 404 URL recorded in state, no entry written.
   - Redirect chain: state shows correct `final_url`.
   - Per-host pacing: timestamps in run journal show ≥1s gaps between
     same-host fetches.
6. **Cache hit run.** Re-run with no SOURCE changes. Expect
   "scraped 0, skipped N from cache, 0 failed". No new files in `urls/`.
7. **Index + search.** `d index update`. `d search <keyword from one of the
   real scraped articles>`. Confirm the scraped entry surfaces.
8. **Linkback walk.** Pick a search hit, read its frontmatter, follow
   `dither_parent_path[0]` to confirm it points at a real source entry.
9. **Tear-down.** Delete the synthetic fixture folder + `state.json`. Repeat
   any step that was ambiguous.

### Lessons we expect to capture

- Final answer on which DOM library survives the sandbox.
- Real-world hit rate of Readability on twitter-linked articles. Anecdotally
  ~70%; we'll have a number after step 4.
- How many URLs in a 10-like sample are dead/blocked; informs whether the
  retry-on-5xx policy is too eager.
- Whether the sequential + 1s-pacing throughput is tolerable for a typical
  user library size (10k likes ≈ 10k seconds = ~2.7 hours single-shot;
  acceptable for an opt-in batch run, painful as a daemon-driven sync).
- Whether the new-parent linkback gap is felt enough during testing to
  prioritize `patchEntry()` for the shippable plugin.

### Decision log

- 2026-05-07 → 08: net grant: extend host so `net: ["*"]` → bare
  `--allow-net=*` (rare; user opt-in at install).
- 2026-05-07 → 08: trigger: manual one-shot only.
- 2026-05-07 → 08: SOURCE: mixed (synthetic fixture + ~10 real likes).
- 2026-05-07 → 08: DOM library: smoke-test first, jsdom → linkedom →
  cheerio → parse5.
- 2026-05-07 → 08: cache: minimal + permanent-vs-transient skip; no
  ETag/304/MAX_AGE/REFRESH.
- 2026-05-07 → 08: dedupe: by URL within a run; new-parent-on-existing
  is a known limitation.
- 2026-05-07 → 08: pacing: per-host serial + `MIN_DELAY_MS=1000`. No
  `Retry-After`, no exponential backoff.
- 2026-05-07 → 08: concurrency: sequential.
- 2026-05-07 → 08: tooling: plain async/await; **not** Effect-TS (over-
  engineered for this scope, sandbox import-time risk).
- 2026-05-07 → 08: structure: 4 files (`extract`, `render`, `cache`,
  `plugin`); rest inline in orchestrator.
- 2026-05-07 → 08: tests: `extract` and `render` only.
