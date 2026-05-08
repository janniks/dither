---
status: draft
priority: P2
---

# URL scraper plugin — spec (DRAFT)

## Problem

Entries promoted by source plugins (twitter-import, imessage, future RSS/raindrop)
carry `urls: [...]` in their frontmatter, but the URLs themselves aren't searchable
content — they're just opaque strings, often shortened (`t.co/...`). We want the
*page text* behind those URLs to be searchable inside dither, with a clear path
back to the originating entry.

Reference (not a port): `mmry-new/src-tauri/scripts/scrape.ts`. Same idea —
JSDOM + Readability — but mmry replaces item content in place. Dither's
source-ownership lock means we write a side-collection and link back.

## Stories

- I liked a tweet that linked a long-form article. I want to find that article
  by its content, not by the tweet I happened to like.
- A friend texted me a `bit.ly` link about Postgres tuning. Six months later
  I want to find it; I can't remember who, when, or what shortener.
- I'm searching `embedding gemma`; I want hits on the underlying GitHub README,
  not just on tweets that linked there.

## Decisions

- **Side-collection, not in-place mutation.** Required by the host's source-
  ownership rule (`plugin-run.ts:130`). Linked back via `dither_parent_id`.
- **Tooling: `npm:jsdom` + `npm:@mozilla/readability`.** Same as mmry-new.
  Readability is the load-bearing extractor; OG/`<meta>` tags are secondary.
- **Watch-fired by default.** Source collections in `watch.collections` (e.g.
  `twitter/**`, `messages/**`); incremental. Backfill via a manual run with a
  `SOURCE` folder grant.
- **One scraped entry per *unique URL*.** If three tweets link the same URL,
  one fetch, one entry, `dither_parent_id` is a list.
- **Body of scraped entry = Readability article text.** That's what gets
  indexed. Frontmatter holds metadata.
- **`urls/**` is not in our own `watch.collections`** → no scraper-fires-scraper
  loops. (The host's loop detector is a backstop, not the primary defense.)

## Output shape

`urls/<host>/<sha1(url)[:12]>.md`:

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
published_at: null
dither_parent_id: ["<source entry id 1>", "<source entry id 2>"]
dither_parent_path: ["twitter/likes/2026/...", "messages/imessage/.../..."]
source: url-scraper
collection: urls/github.com
---

<readability article text>
```

## State (how we track what's scraped)

`state.json` is the scrape cache. Keyed by `source_url` (not final, so we don't
re-fetch shorteners pointlessly):

```json
{
  "schema_version": 1,
  "scrapes": {
    "https://t.co/abc123": {
      "fetched_at": "2026-05-08T11:42:00Z",
      "status": 200,
      "etag": "\"abc-123\"",
      "last_modified": "Tue, 06 May 2026 14:00:00 GMT",
      "final_url": "https://github.com/foo/bar",
      "body_sha1": "...",
      "parents": ["entry-id-1", "entry-id-2"]
    }
  },
  "host_failures": {
    "example.invalid": { "consecutive": 3, "next_retry_at": "..." }
  }
}
```

Decision rules per URL:
- `state.scrapes[url]` exists, status 2xx, fetched within `MAX_AGE` (default
  90d) → **skip** unless `--env REFRESH=1`.
- Status was 4xx (permanent gone) → **skip permanently** unless force.
- Status 3xx loop / 5xx / network error → counts toward `host_failures`;
  next attempt gated by exponential backoff stored in state.
- New parent for an already-scraped URL → **don't re-fetch**, just append
  to `parents` and rewrite the entry's `dither_parent_id` list.

## Efficiency

- **Dedupe within a run** — collect all URLs from all targets, unique by
  source_url, then fetch.
- **Global concurrency cap** (`MAX_CONCURRENCY`, default 4) via a tiny semaphore.
- **Per-host concurrency = 1**, sequential per host, with `MIN_DELAY_MS`
  (default 1000) between requests to the same host. Token-bucket isn't worth
  the code; a per-host `lastFetchAt` map and `await sleep(...)` is enough.
- **HEAD-then-GET only when worth it** — most sites that allow GET also allow
  HEAD; for short URLs the redirect cost is the same whether HEAD or GET. Skip
  the HEAD round-trip; rely on `content-length` from the GET response headers
  + an in-flight stream cap (abort after `MAX_BYTES`, default 5 MB).
- **Conditional GET** when revalidating: send `If-None-Match` / `If-Modified-Since`
  from cached state. 304 → just bump `fetched_at`, no re-extraction.
- **Skip non-HTML.** If `content-type` doesn't match `text/html`, record a stub
  entry with `content_type` set and an empty body — useful for inventory, doesn't
  pollute search.
- **Skip auth-walled.** 401/403 → stub entry, never retry on this URL.
- **MAX_URLS cap** (default empty = no cap; set to e.g. 10 for testing) — same
  shape as twitter-import.

## Rate limit / politeness

- Per-host `MIN_DELAY_MS` (default 1000).
- On 429/503: read `Retry-After` (seconds or HTTP-date), schedule the host's
  `next_retry_at`, skip remaining URLs for that host this run.
- Exponential backoff on host failures: 1m, 5m, 30m, 4h, 24h cap.
- Honor `robots.txt`? — out of scope for v1. Add a `RESPECT_ROBOTS` env stub
  (default off) so we can layer it later without a manifest change.
- Identifying `User-Agent`: `dither-url-scraper/0.1 (+https://github.com/...)`
  by default. Override with `USER_AGENT` env. Note: some sites block obvious
  bot UAs; mmry-new uses Chrome UA. Default to identifying; offer Chrome UA
  as `USER_AGENT_PRESET=chrome` for sites that need it.

## Where this gets hard / what could break

- **Net grant model**: today `manifest.net` is a closed allowlist of hostnames.
  URL scraping needs arbitrary hosts. Blocker — see `notes/url-scraper-plugin.md`
  for options. Likely fix: extend host so `net: ["*"]` becomes bare `--allow-net`,
  prompt-confirmed at install.
- **JSDOM + sandbox**: the `process.env` import-time crash we hit with
  adm-zip / unzipper / fflate may bite again. JSDOM is a *much* bigger surface
  than those. **Must verify on a smoke test before committing.** Fallback if
  it fails: pull just `@mozilla/readability/Readability-readerable.js` + a
  smaller DOM (linkedom) and accept slightly worse extraction.
- **JS-rendered SPAs**: Readability gets nothing; we record what we got
  (often empty body, OG tags only). No headless browser in v1.
- **Private/auth-walled URLs in DMs**: linked Slack/Notion/Drive docs return
  login pages. Stub entry + permanent skip (see "skip auth-walled").
- **Expired t.co for deleted accounts**: 404 chain or 200-with-deleted-page.
  Permanent skip on 404; fuzzy heuristic for the latter (e.g. final URL is
  `twitter.com/account/suspended`) — defer to v2.
- **Watch-fire feedback loops**: scraper writes to `urls/**`; if `urls/**` is
  ever added to our own `watch.collections`, we re-fire forever. Manifest-level
  guard: refuse to start if `watch.collections` overlaps `collections`.
- **Memory blowup on huge pages**: stream cap at `MAX_BYTES` and abort.
- **Encoding mishaps**: declared charset ≠ actual. Trust the response's
  declared `charset`, fall back to utf-8 with `{ fatal: false }` decoding,
  sanitize like mmry-new does.
- **Accidental DoS** of small sites: per-host serialization + min-delay is
  the main defense. Worst case is a user with 5000 t.co links to the same
  domain — they'd issue 5000 requests at 1/sec. Acceptable.
- **Idempotency under URL canonicalization**: `https://github.com/foo/bar` vs
  `https://github.com/foo/bar/` vs `?utm_source=...`. v1: hash the URL exactly
  as it appears (post-redirect we'd dedupe by `final_url`, but that requires a
  fetch). Document the "same-page-twice" risk; revisit with URL normalization.

## Manifest sketch

```json
{
  "name": "url-scraper",
  "version": "0.1.0",
  "dither": {
    "display_name": "URL scraper",
    "tagline": "Scrape URLs found in entry frontmatter into a linked side-collection.",
    "env": [
      { "name": "MAX_URLS",        "default": "" },
      { "name": "MAX_CONCURRENCY", "default": "4" },
      { "name": "MIN_DELAY_MS",    "default": "1000" },
      { "name": "TIMEOUT_MS",      "default": "15000" },
      { "name": "MAX_BYTES",       "default": "5000000" },
      { "name": "MAX_AGE_DAYS",    "default": "90" },
      { "name": "REFRESH",         "default": "" },
      { "name": "USER_AGENT",      "default": "dither-url-scraper/0.1" },
      { "name": "SKIP_HOSTS",      "default": "" }
    ],
    "files": [
      { "id": "SOURCE", "kind": "folder", "required": false,
        "description": "Library subdir to scan for backfill. Omit for watch-only." }
    ],
    "watch": { "collections": ["twitter/**", "messages/**"], "glob": "**/*.md" },
    "net": ["*"],
    "collections": ["urls/**"]
  }
}
```

## Testing in test.local

1. Create two synthetic entries by hand under `test.local/.dither/library/test-source/`
   with `urls: [...]` in frontmatter — one fetchable (e.g. `https://example.com`,
   `https://github.com`), one dead (`https://invalid.example.invalid`),
   one redirect (a `t.co` if you want a real one). `source: test-fixture` in
   frontmatter so the scraper doesn't refuse.
2. Install the plugin pointing `SOURCE` at that folder:
   ```sh
   DITHER_HOME=$PWD/test.local/.dither d plugin install \
     $PWD/test.local/plugins/url-scraper \
     --file SOURCE=$PWD/test.local/.dither/library/test-source \
     --allow-net=*
   ```
3. First run with `MAX_URLS=3` to validate path. Inspect:
   - `state.json` shows three entries with sane `fetched_at` / `status`.
   - `urls/example.com/<hash>.md` etc. exist with Readability text in body.
   - `dither_parent_id` matches the synthetic entry's id.
4. Re-run without changes → 0 promoted (cache hit).
5. Re-run with `REFRESH=1` → hits each URL again; revalidates via
   `If-None-Match` and gets 304 → state `fetched_at` updates, no entry rewrite.
6. Run against the real twitter-import library (small subset via a fresh
   `SOURCE` folder containing 5 likes) — sanity check: per-host pacing,
   no obvious bot-blocks, search hits.
7. Failure-mode check: bad URL → state records failure; second run skips it
   per backoff. 429 simulator (`httpbin.org/status/429` + `Retry-After`) →
   rest of host's URLs deferred.

## Open questions

- Net grant: `net: ["*"]` extension to host vs per-host allowlist? **(blocker)**
- JSDOM survives the sandbox? **(must smoke-test before building)**
- URL canonicalization: dedupe by post-redirect `final_url`? Requires a fetch
  before we know it's a dupe; defer to v2.
- Does the daemon's loop-detector subsume the `watch.collections` ∩
  `collections` overlap check, or do we want both?
- Should scraped entries also carry an `urls: [...]` field of their own (URLs
  *they* link to), letting the scraper feed itself recursively? Tempting; defer.

## Acceptance criteria (v1)

- [ ] Plugin installs and runs against a hand-crafted SOURCE folder.
- [ ] Each successful URL produces exactly one `urls/<host>/<hash>.md` entry.
- [ ] Readability article text appears in the body and is searchable via
      `d index update && d search <article-keyword>`.
- [ ] Re-running without `REFRESH=1` is a no-op (cache hit logged).
- [ ] Per-host requests are serialized with ≥`MIN_DELAY_MS` gap.
- [ ] 4xx URLs are recorded once and skipped on subsequent runs.
- [ ] Multiple parents for the same URL produce one entry with a list-typed
      `dither_parent_id`.
- [ ] Scraped entry's `dither_parent_path` lets `d get` resolve back to the
      source.
