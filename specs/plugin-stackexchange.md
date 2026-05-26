# plugin-stackexchange

## Problem Statement

The user has years of Q&A activity across the Stack Exchange network (Stack Overflow, Server Fault, Math, etc.) — questions they asked, answers they wrote, comments they left, and threads they bookmarked because the content mattered. None of that is in their dither library, so they can't grep their own technical writing or rediscover the highly-rated thread they remember reading three years ago. The rating metadata (upvote counts, accepted-answer flag) that distinguishes a casual reply from a load-bearing answer is also lost when the content lives only on SE.

## Solution

A dither plugin that authenticates against the SE API as the user and pulls every thread the user engaged with into the library as markdown, one file per question thread:

- Questions the user asked
- Threads where the user wrote answers
- Threads where the user left comments
- Threads the user bookmarked (favorites)

Each thread file contains the full Q + all answers (sorted by score, accepted-answer marked) + comments rendered inline, with the user's own posts flagged in both frontmatter and body. Rich frontmatter carries rating metadata (score, answer count, accepted flag) so the user can filter on quality signals later.

The plugin uses OAuth (confidential-client via the `--client-secret` flow shipped in the `dither plugin oauth` CLI) with the `no_expiry` scope, so the user pastes a long-lived `access_token` at install and the plugin never runs a refresh dance.

This plugin **consciously overrides** the project's "content over metadata" rule (per memory `feedback_content_over_metadata.md`). The override is justified because bookmarks and the score frontmatter function as **discovery edges to** and **searchable signal on** content artifacts (the Q&A threads), not as the content itself. The captured artifact is still a markdown document.

## User Stories

1. As a long-time SE contributor, I want every question I asked landed in dither as md, so I can grep my own technical writing the same way I grep articles.
2. As someone who answers on other people's threads, I want my answer entries to include the parent question and the other answers in the thread, so my contribution has the context that made it meaningful.
3. As a thread-bookmarker, I want every question I favorited to land as a full thread md (question + answers + comments), so the thing I saved is the thing I can read offline.
4. As a multi-site user (SO + Server Fault + Math), I want to opt my sites in via env, so the plugin doesn't burn quota on sites where I lurked once in 2015.
5. As a quality-filterer, I want score, answer-count, and accepted-answer flags in frontmatter, so I can later find threads I touched where the top answer crossed 100 upvotes or where my own answer was accepted.
6. As a contributor-finder, I want my own posts flagged both in frontmatter (`my_answer_ids`, `my_comment_ids`) and inline in the body (`**(your answer)**`), so a glance at a file tells me what I wrote without re-reading the whole thread.
7. As an OAuth user, I want a one-time `access_token` paste at install (no refresh dance), so setup is "register app at stackapps, run `dither plugin oauth` once with `--client-secret` and `--scopes=no_expiry`, paste the resulting token into env, done".
8. As a privacy-conscious user, I want a tiny net allowlist (`api.stackexchange.com` only — no image-CDN host), so the install grant is auditable at a glance.
9. As a returning user, I want a delta-only steady-state run (server-side filter via `?fromdate=`), so daily runs cost ~handful of API calls instead of re-walking my full history.
10. As a new user with a long SE history, I want a bounded backfill that survives across runs (backward pointer in state, per-run budget), so the first sync doesn't burst through my quota.
11. As a careful citizen of third-party APIs, I want the plugin to honour SE's `backoff` field strictly (reschedule + exit immediately when it appears), so I never get IP-banned for ignoring it.
12. As a user revisiting old threads, I want re-fetched threads to overwrite the on-disk file with the latest bodies + score counts, so frontmatter reflects today's reality, not first-capture stale values.
13. As a daemon operator, I want the plugin to reschedule cleanly when SE quota approaches exhaustion (`quota_remaining` near zero), so a single greedy run doesn't lock me out of SE for 24h.
14. As a thread-reader, I want answers sorted by score descending with the accepted answer marked in the header, so I see the good stuff at the top when I open the file.
15. As a comment-reader, I want comments rendered as blockquotes directly under their parent post, so the "see also" / "this is wrong because…" replies stay anchored to what they're replying to.

## Implementation Decisions

**Plugin location.** `test.local/plugins/stackexchange/` with `plugin.ts`, `package.json` (manifest), `deno.json`. Co-located smoke tests as `*.test.ts` in the same dir, runnable via `deno test`.

**Manifest (`package.json` → `dither`).**
- `display_name`: "Stack Exchange"
- `tagline`: "Archive your Q&A, bookmarks, and the threads you commented on across the SE network as markdown."
- `schedule`: `0 */6 * * *` (every 6 hours)
- `collections`: one per opted-in site — `stackexchange/stackoverflow`, `stackexchange/serverfault`, …
- `net`: `["api.stackexchange.com"]` only
- `env`:
  - `SE_KEY` (required) — public app key from stackapps registration; lifts daily quota to 10 000
  - `SE_ACCESS_TOKEN` (required) — long-lived OAuth token with `no_expiry` scope
  - `SE_SITES` (default `stackoverflow`) — comma-separated site list to crawl

**Site scope.** Each site in `SE_SITES` is crawled independently. One collection per site. SE question ids are per-site, so per-site collections prevent filename collision. No auto-discovery via `/me/associated` — keeps cost predictable when the user dabbles on new sites.

**Auth — `no_expiry` scope, paste once.** User registers an app at stackapps.com (gets `client_id`, `client_secret`, `key`), runs `dither plugin oauth --client-id=… --client-secret=… --auth-url=https://stackoverflow.com/oauth --token-url=https://stackoverflow.com/oauth/access_token --scopes=no_expiry` once (uses the confidential-client flow shipped via `specs/plugin-oauth-secret.md`), pastes the resulting access_token into env. The plugin runtime never sees the client_secret. No refresh dance, no rotation persisted to state. Plugin fails loudly if `SE_KEY` or `SE_ACCESS_TOKEN` is missing.

**Discovery edges.** Four endpoints per site, each consumed by the cursor engine:
- `/me/questions` — questions the user asked
- `/me/answers` — answers the user wrote
- `/me/comments` — comments the user left
- `/me/favorites` — questions the user bookmarked

Each yields a stream of items; from each item we derive `question_id` (for answers/comments, `question_id` is on the parent post). The per-run union of question ids per site drives a batched `/questions/{ids}?filter=…` fetch which returns each thread with its answers + comments populated. Upvotes-given is intentionally **not** a discovery edge — SE's API doesn't expose the per-user list of upvoted posts even to the user themselves, and we won't HTML-scrape the profile page.

**Response filter — bootstrap on first run, cache in state.** SE's default response strips bodies and most fields; you must pass `?filter=<id>` referencing a custom filter to get `body_markdown`, comments, scores, etc. On first run (or when `state.filter_id` is missing, or when `state.filter_version` is behind the source constant), the plugin POSTs to `/filters/create?include=<desired-fields>&unsafe=false` and caches the returned id in `state.filter_id`. Desired fields (committed in source as a constant list):

`body_markdown`, `score`, `is_accepted`, `creation_date`, `last_edit_date`, `last_activity_date`, `tags`, `owner.display_name`, `owner.user_id`, `link`, `title`, `answer_count`, `accepted_answer_id`, nested `comments` (with `body_markdown`, `score`, `creation_date`, `owner`), nested `answers` (with their own bodies + comments + scores).

**Fallback** if the filter-create path proves troublesome to implement cleanly: drop to SE's built-in `withbody` filter and make supplementary `/questions/{ids}/comments` + `/questions/{ids}/answers` calls per thread to fill the gap. Less efficient (2N extra calls per run on backfill) but no filter management.

**Pagination — two-pointer model.** Mirrors readwise/raindrop project convention. Per `(site, endpoint)` pair, state carries:

- `last_sync` (unix seconds, nullable) — forward pointer. Each run calls `?fromdate=<last_sync>&order=desc&sort=activity&pagesize=100` and pulls the delta. On a fully-drained pass, advances to the run-start unix. On a budget-truncated pass, **does not advance**, so the next run resumes from the same point.
- `backfill_page` (integer, default 0) + `backfill_done` (bool, default false) — backward pointer. Walks the user's full history one page at a time (`?page=N&pagesize=100&order=desc&sort=creation`) until `has_more === false`, then sets `backfill_done = true`. Survives across runs.

**Per-run budget.** 50 HTTP calls per run. Forward pass first (catches what changed since `last_sync`), backward pass runs with whatever budget remains. Budget is a *soft* cap — a request that's already in flight isn't cancelled, but no new request is started once the budget is depleted. Well under SE's 10 000/day quota even with 4 endpoints × 3 sites = 12 forward calls and dozens of batched `/questions/{ids}` calls per run.

**Rate-limit hygiene — strict backoff.** Every SE response carries an optional `backoff` field (seconds). Rule: if `backoff` appears, immediately call `reschedule({ afterMs: backoff*1000, reason: "se backoff" })` and exit. 429 with `Retry-After` gets the same treatment. `quota_remaining` near zero (configurable threshold, default ≤ 100) ⇒ reschedule for next day and exit. Light self-throttle inside a single run (≤ 5 req/s) keeps the 30/s burst limit unreachable.

**Refetch policy — full rewrite on activity bump.** Forward pointer's `sort=activity&order=desc` captures both new threads and any thread whose `last_activity_date` advanced (new answers, edits, new comments). Returned thread ids re-run through `/questions/{ids}`; the resulting md file overwrites whatever was on disk. `captured_at` in frontmatter is the write time of the latest pass. No merge logic, no "first seen" tracking — the on-disk file is always SE truth as of the most recent run that touched it.

**Entry shape — one md file per thread.** Key = `question_id`. File body = question + answers (sorted by score desc) + comments rendered inline as blockquotes under each parent post. Multiple discovery edges on the same thread merge onto the same file (e.g. you bookmarked a thread and also commented on it ⇒ one file with `bookmarked: true` *and* `my_comment_ids: [...]`).

**Filename + collection layout.**
- Collection: `stackexchange/<site>/` (e.g. `stackexchange/stackoverflow/`)
- Filename: `<question_id>.md`

**Body rendering.**

```
# <title>

<question body_markdown>

> <comment body_markdown> — by <author> (<score> ↑)
> <comment body_markdown> — by <author>

**(your question)**     ← only if my_question

## Answer by <author> — <score> ↑ ✓ accepted     ← ✓ accepted only on the accepted post

<answer body_markdown>

> <comment> — by <author>

**(your answer)**     ← only if this answer is the user's

## Answer by <author> — <score> ↑

…
```

No table of contents, no metadata table at the top — frontmatter carries the metadata, the body is the conversation.

**Frontmatter — slim, omit-when-default.**

```yaml
id: 42
site: stackoverflow
title: "<question title>"
url: <link from API>
tags: [react, javascript]
score: 142
answer_count: 7
has_accepted: true
my_question: true       # omitted when false
my_answer_ids: [123]    # omitted when empty
my_comment_ids: [789]   # omitted when empty
bookmarked: true        # omitted when false
asked_at: <ISO8601>
last_activity_at: <ISO8601>
captured_at: <ISO8601>
```

No `top_answer_score` / `top_answer_is_mine` / `view_count` — derivable from body if ever needed, and bloats every file otherwise.

**Image handling.** SE `body_markdown` embeds images as `![](https://i.sstatic.net/…)`. We leave URLs as-is, no mirroring (matches project convention). `i.sstatic.net` is **not** in the net allowlist; plugin only talks to `api.stackexchange.com`.

**Edge cases.**
- **Deleted posts**: SE's API doesn't return them to non-moderators; effectively invisible — drop silently.
- **Closed / locked questions**: body still readable; capture as normal. No `closed` / `locked` flag in frontmatter.
- **Community wiki**: `owner.user_id` is special-cased ("Community"); render normally.
- **Migrated questions**: dedup is by `(site, question_id)`; a migration produces a new file on the new site, the original-site file goes stale. Acceptable; not worth merging.
- **Pagesize > what the API returns**: if a thread has 500 answers and the API caps the embedded `answers` array at e.g. 100, we accept the cap — no per-thread chase to grab all 500. Frontmatter `answer_count` reflects SE's reported total even if the rendered body is partial.

**State shape.**

```
{
  "filter_id": "!nNPvSNVZJS",          // null on first run
  "filter_version": 1,                  // bumped when desired-fields constant changes
  "cursors": {
    "<site>:<endpoint>": {
      "last_sync": 1716700000,          // unix seconds or null
      "backfill_page": 3,               // 0 on first run
      "backfill_done": false
    },
    // one entry per (site, endpoint) pair the plugin has touched
  }
}
```

**Progress reporting.** Standard `progress({ message })` at:
- Start: `"sites: stackoverflow, serverfault — budget 50 calls"`
- After filter bootstrap (only first run): `"filter ready: <id>"`
- Per forward call: `"forward stackoverflow/answers (N new)"`
- Per backward page: `"backfill stackoverflow/questions page 4 (98 items, has_more)"`
- After batched threads fetch: `"fetched 23 threads"`
- Before exit: `"wrote X new, Y updated; budget left N"`

## Testing Decisions

A good test here is one that exercises the code without going to the network. Tests are co-located in `test.local/plugins/stackexchange/` as `*.test.ts`, runnable via `deno test`. **Smoke level only** — only the modules whose failure modes are silent and high-impact. Do not touch the CLI / plugin-host test suites.

What we test (two smoke tests):

- **`render.test.ts`** — fixture-based. Given a fixed question object (Q + 2 answers + comments + the user's own answer set), assert the rendered body string:
  - Starts with `# <title>` h1
  - Question body comes first, then comments as blockquotes
  - Answers appear in score-descending order
  - Accepted answer's header carries the `✓ accepted` marker
  - The user's own answer carries the `**(your answer)**` marker
  - Frontmatter omits `my_question: false` and other default-false flags
- **`cursors.test.ts`** — pure-function test of the two-pointer engine. Given a fresh state, asserts:
  - First request emitted is the forward pass on the first (site, endpoint) pair
  - On a budget-truncated forward pass, `last_sync` does **not** advance
  - On a fully-drained forward pass, `last_sync` = run-start unix
  - Backward pass advances `backfill_page` only when `has_more` was true on the just-drained page
  - When `has_more === false`, `backfill_done` flips to true and that endpoint is dropped from the backward queue

Skip tests on `client.ts` (URL assembly is shallow), `filter.ts` (one-shot bootstrap), `discover.ts` (transformation is simple), and `plugin.ts` orchestrator (plugin-host integration tests cover orchestrator wiring at the host level).

## Out of Scope

- **Upvotes-given as a discovery edge.** SE's API doesn't expose the user's list of upvoted posts; the browser profile page is the only surface and we won't HTML-scrape.
- **`/me/inbox`, `/me/notifications`.** Pure transient metadata. Also: reading inbox sometimes auto-marks items read on SE, which would be a surprising side effect.
- **Badges, reputation history, tag follows.** Metadata-only without content artifacts.
- **Mod-only data** (deleted posts, suspension info).
- **Image mirroring** — URLs stay remote.
- **A refresh-token dance.** `no_expiry` scope removes the need.
- **Auto-discovery of SE sites** via `/me/associated`. Sites are explicit via `SE_SITES`.
- **Merging migrated questions** across sites.
- **Per-answer score breakdown nested in frontmatter.** `my_answer_ids` + score in body is enough.
- **`top_answer_score` / `top_answer_is_mine` / `view_count`** in frontmatter (Q9 b: slim set).
- **`closed` / `locked` / `community_wiki` flags** in frontmatter (derivable, slim set wins).
- **Chasing per-thread pagination** when an answers/comments array is capped by the API. We render what one fetch gives us; `answer_count` in frontmatter still reflects SE's reported total.
- **The hosted OAuth helper page that produces the access_token.** N/A here — we use `no_expiry` + the existing `dither plugin oauth --client-secret` CLI.

## Further Notes

- SE's OAuth endpoint is `https://stackoverflow.com/oauth` for the **whole network**, not per-site. One token works across every site the user has an account on.
- SE caps each endpoint's results at 10 000 items total. Past 10 000 you literally cannot paginate further. Affects only very prolific users; treat as "good enough".
- SE filter ids are stable and network-wide. The same `state.filter_id` works for every site we crawl.
- The `key` env is public, not secret — it's a quota tagger so SE knows which app is calling. Leaking it has no security implication (worst case: someone bumps quota usage on your app key).
- SE doesn't have an "all my activity, network-wide" endpoint. Per-site enumeration is forced by the API shape.
- This plugin consciously overrides the project's "content over metadata" memory rule. Justification: bookmarks function as discovery edges to content artifacts (threads), and frontmatter scores are searchable signal *on* a captured content artifact — not standalone metadata captures. The artifact is still markdown; the metadata rides along.
- The two-pointer model with `sort=activity` on the forward pointer means "delete + re-add" on SE doesn't lose us anything (deletes don't surface anyway), and edits do surface as the parent thread's `last_activity_date` advances. The forward pointer is correct for both new threads and updates to old ones with a single endpoint hit.
- Heavy first-run backfill on a user with 10 years of activity on 3 sites = roughly (4 endpoints × 3 sites × ~10 pages) = 120 forward-history calls + ~50–200 batched thread fetches. At 50 calls/run and every-6h scheduling, full backfill finishes in 1–2 days, well inside the 10k/day quota.
