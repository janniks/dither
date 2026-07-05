# twitter hydration — scraper API shortlist

Goal: hydrate takeout tweet refs by ID (~110k likes/bookmarks/tweets with
truncated text) via a dither plugin. Apify preferred for ease of use.

## Split: public vs private

- **Private syncs** (own bookmarks/likes/DMs, ongoing): xurl + official API
  "owned reads" at $0.001/read — cheapest legitimate path for private data,
  and the only one. OAuth via xurl; plugin shells the same endpoints.
- **Public hydration + expansion** (tweet bodies, quote tweets, replies,
  embedded URLs): scrapers below, 10–30× cheaper than official reads.
  Anything visible logged-out is fair game for the cheap path.

## Expansion actors (per tweet URL/ID)

- Replies: **scraper_one/x-post-replies-scraper** — $0.20/1k replies,
  input = post URLs (≤100/run, ≤1k replies each), 4.98★.
- Replies + retweets: **api-ninja/x-twitter-replies-retweets-scraper** —
  $0.35/1k, URLs or IDs, `parseAllResults` for full pagination, 5★.
- Quotes: no cheap dedicated actor — twitterapi/twitter-get-quotes-v2 is
  $3/1k. Cheaper: run `quoted_tweet_id:<id>` through an advanced-search
  actor (delicious_zebu 4.89★ / api-ninja 4.71★) or twitterapi.io's quotes
  endpoint at ~$0.15/1k.
- Embedded URLs: no actor needed — url-scraper plugin already follows
  frontmatter `urls: []`; hydration just enriches that list.

## Pick (Apify)

- **xquik/x-tweet-scraper** — $0.15/1k, batch up to 10k tweet IDs/run,
  no minimums, dedup before billing, 100% run success. ~$17 full pass.
- Fallback: **kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest**
  — $0.18–0.25/1k, `tweetIDs` input, 17k users (most battle-tested).
- Also fine: **scrape.badger/twitter-tweets-scraper** — $0.15/1k + platform
  usage, 4.89★.
- **danek/twitter-scraper** — $0.24–0.30/1k, `lookup_post_ids` batch input,
  6.6k users, 3.9★. Third option if the two above disappoint.
- Full store sweep (93 actors, store API): everything else is search-,
  profile-, follower-, replies- or trends-shaped; xtdata prohibits
  single-tweet fetch; scraper_one is keyword-search only.

## Non-Apify (cheaper ops, direct REST)

- **twitterapi.io** — $0.15/1k ($0.00015/read), 1000 req/s, pay-as-you-go.
  Cleanest for a sandboxed Deno plugin: one `allow-net` host, no actor-run
  orchestration. Free credits to test.
- **socialdata.tools** — $0.20/1k, pay-as-you-go.

## Rejected

- apidojo/tweet-scraper (V2) — $0.40/1k, no single-tweet fetch, min 50/query.
- apidojo/twitter-scraper-lite — $0.05 per tweet URL → ~$5.5k for our pass.
- twitterapi/twitter-get-quotes-v2 — $3/1k, quotes-only, 84 users.
- Official X API — $0.005/read (~$550); legacy tiers closed to new devs.
  xurl = official CLI over this, DX only, same pricing.

## Plugin sketch (Apify path)

- net grant: `api.apify.com`; env: `APIFY_TOKEN`.
- Read tweet_ids from library twitter/{likes,bookmarks}, batch 10k per
  actor run (`xquik/x-tweet-scraper`), poll run → dataset items.
- Idempotent: entry id = tweet id, overwrite same file (promotion allows
  same-source clobber); update body with full text + author + media urls.
