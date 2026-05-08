---
status: draft
priority: P2
---

# URL scraper plugin (working name: `url-scraper`)

Tiny dither plugin: take a source collection, find entries with `urls: [...]` in
frontmatter, fetch each URL, and emit a new entry per URL in a side-collection
linked back to the source via `dither_parent_id`.

Reference implementation: `mmry-new/src-tauri/scripts/scrape.ts` — a Tauri-app
worker, not a plugin. Pattern:
- Pick URL from `item.meta.url`, fall back to first `https?://` in content.
- Fetch with a Chrome desktop `User-Agent` (real sites serve different HTML to
  bot UAs).
- **JSDOM + `@mozilla/readability`** to extract the main article text — handles
  nav/ads/sidebars correctly. This is the right tool, not regex / OG-only.
- UTF-8 sanitize, write back into the item's `content`, mark `needs_chunking=true`.
- Only "leaf" items (no children) are scrape-eligible — guards against
  re-scraping already-enriched items.

Two important differences for dither:
- mmry replaces content **in place**. Dither's source-ownership lock forbids
  cross-plugin overwrites, so we still need a side-collection with `dither_parent_id`.
- mmry runs the worker as a one-shot per item id (queued by the Rust side).
  Dither's natural fit is watch-fired: each new entry under SOURCE → fire scraper
  on its targets. Same effect, different orchestration.

## Behavior

- Input: a source collection (e.g. `twitter`, or `twitter/likes`).
- For each `*.md` under it, parse frontmatter; if `urls` is a non-empty array,
  iterate.
- For each URL: GET with a Chrome `User-Agent` (auto-follows redirects, so t.co
  unfurls naturally), parse with JSDOM, run Readability for the main article.
- Emit a new entry per URL with frontmatter:
  - `source_url` (original — pre-redirect)
  - `final_url` (after redirects, from `response.url`)
  - `status` (HTTP)
  - `content_type`
  - `title` (Readability article title; fall back to `<title>`)
  - `byline` (Readability)
  - `excerpt` (Readability)
  - `site_name`, `published_at` (OG/article meta — secondary)
  - `dither_parent_id`: original entry's `id`
  - `dither_parent_path`: relative library path to the source
- **Body**: the Readability-extracted article text (`article.textContent`).
  This is the load-bearing piece for search — clean prose without nav chrome.
- Path: `urls/<host>/<short-hash>.md` where hash = `sha1(source_url).slice(0,12)`.
- Idempotent: stable id from the URL, re-runs overwrite cleanly.
- "Leaf-only" guard adapted to dither: skip if the source entry already has
  `source: url-scraper` (i.e. don't scrape our own scraped entries).

## Constraints discovered while exploring

1. **Source-ownership lock on promote** (`plugin-run.ts:130`): a plugin can only
   overwrite an entry whose frontmatter `source` matches its own name.
   → Confirms we *must* write a side-collection, not mutate source entries.
   The `dither_parent_id` linkback is how we re-attach context.

2. **No library-wide read access**. Plugins get read on:
   (a) their own dir, (b) declared `files[]` grants, (c) watch `targets`.
   → To scan a source collection in bulk (manual run / backfill), we need a
   `folder` grant pointing at the collection root. Watch mode handles
   "going forward" via targets without a grant.

3. **`--allow-net` is a closed list** (`manifest.ts:30` + `plugin-run.ts:292`).
   Today net grants are explicit hostnames; URL scraping needs arbitrary hosts.
   Three options, in order of escalating change:
   - **a**) Take a comma-sep host allowlist as install-time grant — fine for
     scoped use (e.g. only `t.co,bit.ly,youtube.com`), useless for general
     "scrape whatever shows up in user data".
   - **b**) Extend host: support `net: ["*"]` meaning bare `--allow-net` (any).
     Small change in `plugin-run.ts:292`; should require explicit user opt-in
     at install time (e.g. `--allow-net=*` becomes prompt-confirmed).
     **This is the recommended path** — gates wide net behind an explicit
     grant rather than silently bypassing.
   - **c**) Two-stage: this plugin emits placeholder entries with the source
     URLs, and a separate fetcher (run outside the sandbox) does the actual
     network. Avoids the host change but doubles the surface area.

4. **Per-host courtesy** (rate limit, robots.txt, identifying UA): out of scope
   for v1 but worth a TODO.

## Manifest sketch (after constraint 3 is resolved)

```json
{
  "name": "url-scraper",
  "version": "0.1.0",
  "dither": {
    "display_name": "URL scraper",
    "tagline": "Scrape URLs found in entry frontmatter into a linked side-collection.",
    "env": [
      { "name": "MAX_URLS",   "default": "", "description": "Cap fetches per run; empty = no cap." },
      { "name": "TIMEOUT_MS", "default": "10000" },
      { "name": "USER_AGENT", "default": "dither-url-scraper/0.1 (+https://dither.local)" },
      { "name": "SKIP_HOSTS", "default": "", "description": "Comma-separated hosts to ignore." }
    ],
    "files": [
      { "id": "SOURCE", "kind": "folder", "required": true,
        "description": "Library subdirectory to scan (e.g. ~/.dither/library/twitter)." }
    ],
    "watch": { "collections": ["twitter/**", "messages/**"], "glob": "**/*.md" },
    "net": ["*"],
    "collections": ["urls/**"]
  }
}
```

Two run shapes:
- **Manual / scheduled**: walk the SOURCE folder once. Good for backfill.
- **Watch-fired**: process only `targets`. Good for incremental.

## Output entry shape

```yaml
---
id: 9f3c6b1a2c4e
kind: url-scrape
source_url: https://t.co/abc123
final_url: https://github.com/foo/bar
status: 200
content_type: text/html
title: foo/bar — A great repo
description: A short description of the project.
site_name: GitHub
image: https://opengraph.github.com/...
published_at: null
dither_parent_id: <original entry id>
dither_parent_path: twitter/likes/2026/2051733365888274878.md
fetched_at: 2026-05-07T11:42:00Z
source: url-scraper
collection: urls/github.com
---

foo/bar — A great repo

A short description of the project.
```

Hash for filename: `sha1(source_url).slice(0, 12)` (collision-resistant enough at this scale).

## Open questions

- Wildcard net (constraint 3): is it acceptable to extend the host, or do we
  scope per-host? **Needs decision before implementing.**
- Search-side: how do we surface the parent linkback in `d search` results so
  hits on scraped pages also point users to the originating tweet/message?
  Maybe `d get --with-parent` or a generic `dither_parent_id` resolver.
- Multiple parents: if the same URL appears in two source entries, do we
  deduplicate (one scraped entry, `dither_parent_id` becomes a list) or
  emit a separate entry per parent (cleaner blast radius)?
  Probably dedupe with a list — saves re-fetches and keeps the index lean.
- Robots.txt + per-host backoff: skip, advisory comment, or enforce?
- HTML parsing: settled — `npm:jsdom` + `npm:@mozilla/readability`, matching
  mmry-new. Heavier than linkedom but Readability needs full JSDOM. Acceptable
  cost for a one-shot scraper plugin; check that JSDOM doesn't trip the
  `process.env` sandbox issue we hit with adm-zip / unzipper / fflate.
- Non-HTML responses (PDF, images): record `content_type` + skip body, or
  refuse to emit at all? Probably emit a stub — useful for search/inventory.

## Decision log

- 2026-05-07: scope decided as *side-collection with parent linkback*, not
  in-place mutation, because of source-ownership lock.
- 2026-05-07: implementation deferred until net-grant model is decided.
- 2026-05-07: tooling = JSDOM + Mozilla Readability (per mmry-new/scrape.ts);
  not regex / OG-only.
