# twitter-hydrate

## Problem Statement

The twitter takeout import produces ~110k entries whose content is thin:
likes and bookmarks carry only truncated `fullText`, and follow/follower
entries are just an account id + intent URL with an empty story. The
data to enrich them (full text, resolved links, author info, bios) is
public, but the official API is ~30× the cost of scraper APIs. Entries
also carry t.co shortlinks that hide the real destinations from the
url-scraper pipeline.

## Solution

A new watch plugin `twitter-hydrate` (test.local, separate from
twitter-import for now) that hydrates takeout entries in place via
twitterapi.io: full tweet text with t.co links resolved, quoted tweets
inlined, engagement metadata in frontmatter, profile bios for
follows/followers, and resolved URLs written to the canonical `urls`
frontmatter list so url-scraper (and future plugins) can consume them.

Enabling in-place enrichment requires one core change: plugins get
fine-grained collection permissions — `create` (today's `collections`)
and a new `edit` grant that permits replacing entries another plugin
created, consented at install.

## User Stories

1. As a takeout owner, I want my liked tweets' full text fetched, so that truncated likes become readable, searchable documents.
2. As a takeout owner, I want bookmarks hydrated the same way, so that my saved tweets carry their actual content.
3. As a takeout owner, I want t.co shortlinks in tweet bodies replaced with their real targets, so that stored markdown reads like the tweet and links don't rot behind a redirector.
4. As a takeout owner, I want resolved URLs in the `urls` frontmatter field, so that the url-scraper plugin scrapes the linked articles later.
5. As a takeout owner, I want quoted tweets rendered inline as blockquotes, so that the thing I liked is one self-contained document.
6. As a takeout owner, I want engagement counts (likes, retweets, replies, quotes, views, bookmarks) in frontmatter when available, so that metadata is queryable without polluting the body.
7. As a takeout owner, I want follow/follower entries enriched with the account's bio as body and profile metadata in frontmatter, so that my graph entries are content, not bare ids.
8. As a takeout owner, I want a profile's website and any URLs in its bio added to the `urls` frontmatter field, so that other plugins treat profiles like any other entry.
9. As a library owner, I want newly imported twitter entries hydrated automatically via watch, so that steady-state needs no manual step.
10. As a library owner, I want a manual backfill that only processes unhydrated entries, so that I can seed the existing corpus in controlled, resumable slices.
11. As a cost-conscious user, I want a per-run cap, so that a backfill slice spends a bounded amount.
12. As a cost-conscious user, I want deleted tweets/accounts stamped terminal on a successful lookup that omits them, so that backfill converges and I never re-pay for ghosts.
13. As a security-conscious user, I want plugins unable to alter or delete other plugins' entries by default, so that the library is append-only except where I explicitly consent.
14. As a plugin installer, I want the `edit` grant surfaced as its own consent line, so that overwriting other plugins' entries is a deliberate decision.
15. As a plugin author, I want `hydrated_at` stamped in frontmatter, so that "needs hydration" is derivable from the entry itself with no state file.

## Implementation Decisions

Core — grant vocabulary:

- Rename manifest `collections` → `create`; add sibling `edit`. Both are
  flat glob lists over the collection namespace, same grant-pattern
  grammar and validation. Grants file mirrors both.
- Promotion clobber rule: same `source` → overwrite OK (unchanged,
  normal sync refresh); different `source` + `edit` glob covers the
  collection → overwrite OK; different `source`, no `edit` grant →
  **skip the file** (warn in the run journal, count skipped in the
  result) — do NOT fail the run. Skipped files are never copied, so no
  watch event fires and enriched entries are never reset.
- `edit` does not imply `create`; plugins declare both if they need both.
- No delete capability for plugins, ever. `remove` deliberately not
  reserved/implemented. Future direction (noted, not built): a `read`
  mode unifying watch's implicit read access.
- Clean break: no alias, no migration code (pre-stable). All test.local
  manifests renamed in the same change; installed plugins reinstalled
  manually.

Plugin — twitter-hydrate:

- Manifest: env `TWITTERAPI_KEY` (required) + `MAX_ITEMS` (empty = no
  cap); `net: ["api.twitterapi.io"]`; `create: ["twitter/**"]`,
  `edit: ["twitter/**"]`; `watch.collections: ["twitter"]`.
- Scope: likes + bookmarks (tweet endpoint) and follows/followers (user
  endpoint), routed by the entry's `kind` frontmatter. Own tweets,
  note/community tweets, DMs: not hydrated.
- Triggers: watch for new promotions; `--backfill` for seeding. Both
  idempotent: entries with `hydrated_at` are skipped before any API
  call, so backfill is resumable and re-runs are free.
- API: twitterapi.io batch endpoints, `X-API-Key` header, 100 ids per
  call, sequential, no pacing (well under the 200 QPS ceiling).
- Gone rule: stamp `hydrated_at` + `hydrate: gone` (body unchanged) only
  when the batch request succeeded and the id was absent from the
  response. Failed requests stamp nothing — those ids retry next run.
- Tweet output: body = full text with t.co replaced by expanded URLs
  (entity mapping; unmapped t.co left as-is), quoted tweet appended as
  an attributed blockquote. Frontmatter: existing fields preserved +
  author handle/name, engagement counts when present, quoted/reply ids,
  `media_urls`, resolved `urls` (takeout ∪ API entities, deduped),
  `hydrated_at`.
- Profile output: body = bio; frontmatter += handle, name, follower/
  following counts, location, website, account `created_at`,
  `hydrated_at`; `urls` = website ∪ bio URLs, resolved.
- Watch self-fire is harmless: suppression is best-effort (2s TTL), but
  the `hydrated_at` skip makes re-fires no-ops; loop detector caps depth.

twitter-import (same change set):

- Create-only: declares `create: ["twitter/**"]`, no `edit`. Re-import
  with a fresh takeout only adds new entries; existing (possibly
  hydrated) entries are skipped at promote — no reset, no re-hydration
  spend, no watch storm.
- Delete blocks/mutes emitters and their render paths.
- Keep following/followers; body becomes empty (URL already lives in
  `user_link` frontmatter) until hydration fills it with the bio.
- Content-over-metadata note: follows earn their place only because
  hydration turns them into profile documents.

Modules:

- `api.ts` — twitterapi.io client: `tweets(ids)` / `users(ids)` → typed
  results with explicit ok/failed so gone-stamping can distinguish
  success-with-absence from request failure. Fetch injected.
- `render.ts` — pure, deep: (existing frontmatter, api object) →
  EntryOptions. Owns t.co rewriting, quote rendering, urls union,
  engagement/profile frontmatter, hydrated/gone stamping. No I/O.
- `plugin.ts` — thin orchestrator: targets → parse frontmatter → skip
  hydrated → route by kind → batch → emit → progress.

## Testing Decisions

- Test external behavior only; no mocks beyond injected fetch.
- `render.ts`: pure input/output tests — t.co resolution, quote
  blockquote, urls union (tweet and profile variants), gone stamping,
  engagement fields present/absent.
- `api.ts`: injected-fetch tests for the three outcomes (success with
  all ids, success with absent ids, request failure).
- Core: extend existing promotion tests with edit-grant cases —
  cross-plugin overwrite allowed with grant, skipped (not failed)
  without, skip journaled + counted, no watch-visible write for skipped
  files, same-source overwrite unchanged.
- `plugin.ts` orchestration untested (glue; daemon integration tests
  cover the watch path). Prior art: url-scraper-test's render/extract
  test split.

## Out of Scope

- Quote-tweet/reply *expansion* (fetching other people's replies/quotes
  as new entries) — future plugin or extension; shortlist lives in
  notes/twitter-hydration-scraper-apis.md.
- Private-data sync via xurl/official API (bookmarks sync, DMs) —
  separate future plugin, separate auth lane.
- Merging twitter-hydrate into twitter-import.
- Hydrating own tweets/retweets for engagement counts alone.
- Frontmatter-patch SDK (notes/plugin-api-update-entry.md) — edits here
  are whole-entry rewrites through the normal promote path.
- `read`/`remove` grant modes; glob→modes map shape (revisit if a third
  mode ever appears).

## Further Notes

- Cost estimate: ~100k tweets ≈ $15 + profiles at $0.18/1k. Backfill in
  slices via MAX_ITEMS; "remaining" is countable by grepping for entries
  missing `hydrated_at`.
- twitterapi.io response includes nested `quoted_tweet`/`retweeted_tweet`
  objects — the quote render costs no extra API spend.
- Entry filenames are ids (tweet id / account id), so hydrate's output
  lands on the exact same path via the edit grant; idempotency is
  filename-level, same as import.
