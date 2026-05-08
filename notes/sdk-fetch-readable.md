---
status: idea
priority: P3
---

# SDK helper: fetch a URL → readable markdown

Sister thought to `url-scraper-plugin.md`. That note is about a *plugin* that
consumes URLs from entries. This is about the *primitive* underneath: a
`@dither/plugin` SDK function any plugin can call to turn one URL into clean
markdown.

## Why

Came up while writing `github-stars`. Each starred repo has a `homepage` and
README URL — would be nice to optionally fetch + extract a snippet for the
entry body, instead of just dropping a link. Same shape will recur in any
plugin that ingests link-shaped data (raindrop, pocket, twitter bookmarks,
hn-favorites, etc.). Today every author would have to:

- import jsdom + @mozilla/readability themselves
- handle UA + redirects + content-type sniffing
- ask the user for a wildcard `--allow-net` grant

Hide all of that behind one call. Makes the "scrape one URL" path a one-liner
for any plugin, not just a dedicated scraper.

## Sketch

```ts
import { fetchReadable } from "@dither/plugin";

const page = await fetchReadable("https://example.com/post");
// { url, finalUrl, status, contentType, title, byline, excerpt, markdown, html }
```

Internals: same JSDOM + Readability stack the url-scraper plugin lands on,
plus turndown (HTML → markdown) so the body comes back as md, not raw text.

## Open questions

- **Net grant model.** Same blocker as `url-scraper-plugin.md` constraint 3:
  arbitrary URLs need wildcard net. If the SDK helper is *the* sanctioned way
  to do scraping, maybe the host can grant a narrower thing — e.g. an opt-in
  `"scrape": true` manifest flag that gates the helper, separate from raw
  `net: ["*"]`. Same outcome, but the user prompt is "this plugin wants to
  scrape web pages" not "this plugin wants unrestricted internet."
- **Where it lives.** SDK function vs. host RPC. SDK is simpler (just code
  the plugin runs); host RPC would let the host enforce per-domain rate
  limits, caching, and respect robots.txt centrally. RPC probably wins long
  term, but SDK ships first.
- **Caching.** If two plugins both fetch the same URL in the same hour, one
  request would be ideal. Argues for host RPC + a small on-disk cache under
  `~/.dither/cache/scrape/`.
- **Relationship to the url-scraper plugin.** If this helper exists, the
  url-scraper plugin shrinks to ~30 lines (walk entries → call helper →
  writeEntry). That's probably the right factoring: helper for one-shot,
  plugin for batch/watch.
- **Non-HTML.** PDFs, images, JSON: same question as the plugin note. Helper
  should probably return `{ markdown: null, contentType }` and let the caller
  decide.

## Decision log

- 2026-05-08: parked. Wait for the url-scraper plugin to land first — it
  forces the net-grant decision, and once that's settled the helper is a
  small refactor on top.
