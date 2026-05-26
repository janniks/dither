# Plan: plugin-stackexchange

> Source spec: `specs/plugin-stackexchange.md`

## Architectural decisions

- **Plugin location**: `test.local/plugins/stackexchange/` — `plugin.ts` + helpers + `deno.json` + `package.json`. Co-located smoke tests as `*.test.ts`.
- **Auth**: confidential-client OAuth with `no_expiry` scope. Env at runtime is `SE_KEY` + `SE_ACCESS_TOKEN`. Plugin never sees the `client_secret`.
- **Net allowlist**: `api.stackexchange.com` only.
- **Collections**: `stackexchange/<site>` per opted-in site (filename = `<question_id>.md`).
- **Response filter**: bootstrap on first run via `/filters/create`, cache id in state. Fallback: built-in `withbody` + supplementary endpoints if first path proves troublesome.
- **Pagination**: two-pointer (forward `?fromdate=` per `(site, endpoint)`, backward `?page=N`) — mirrors readwise/raindrop.
- **Refetch policy**: idempotent rewrite on activity bump.
- **Rate-limit hygiene**: strict `backoff` field → `reschedule()` + exit; `quota_remaining` near zero → reschedule for next day; ≤ 5 req/s self-throttle.
- **State shape**:
  ```
  {
    schema_version: 1,
    filter_id: string | null,
    filter_version: 1,
    cursors: { "<site>:<endpoint>": { last_sync: number|null, backfill_page: number, backfill_done: boolean } }
  }
  ```
- **Discovery edges**: `/me/questions`, `/me/answers`, `/me/comments`, `/me/favorites`. No upvotes-given.

---

## Phase 1: Walking skeleton — forward sync of one discovery edge

**User stories**: 1, 2, 6, 7, 8, 13, 14, 15, 16

End-to-end demoable: install the plugin, paste your access_token, run it. The questions *you asked on stackoverflow.com* land as md files (full thread bodies: Q + answers sorted by score + comments + your-post markers + slim frontmatter). Refetch on activity bump works (idempotent rewrite). Forward pointer only. Hardcoded site = `stackoverflow`, hardcoded endpoint = `/me/questions`.

**Acceptance:**
- [x] `test.local/plugins/stackexchange/{package.json, deno.json, plugin.ts}` exist; plugin loads under the host without errors.
- [x] Manifest declares `display_name`, `tagline`, `schedule: 0 */6 * * *`, `collections: ["stackexchange/stackoverflow"]`, `net: ["api.stackexchange.com"]`, env entries for `SE_KEY` + `SE_ACCESS_TOKEN`.
- [x] Missing `SE_KEY` or `SE_ACCESS_TOKEN` throws with a clear message before any HTTP call.
- [x] On first run, plugin POSTs to `/filters/create` with the desired-fields constant, caches the returned id in `state.filter_id`.
- [x] Plugin GETs `/me/questions?site=stackoverflow&fromdate=<last_sync>&order=desc&sort=activity&filter=<state.filter_id>&pagesize=100`, paginates via `has_more` + `page`, collects `question_id` set.
- [x] Plugin batches `/questions/{ids}?site=stackoverflow&filter=<state.filter_id>` (up to 100 ids per call), pulls each thread with nested answers + comments.
- [x] For each thread, writes `<question_id>.md` to collection `stackexchange/stackoverflow/` with frontmatter (`id`, `site`, `title`, `url`, `tags`, `score`, `answer_count`, `has_accepted`, `my_question: true`, `asked_at`, `last_activity_at`, `captured_at`) and the documented body shape (h1 title, question body, blockquoted comments, `## Answer by … — N ↑` headers sorted by score desc, accepted marker, your-post inline markers).
- [x] Omit-when-default rule applied (e.g. `my_answer_ids` not emitted when empty).
- [x] After a clean forward pass, `state.cursors["stackoverflow:questions"].last_sync = run_start_unix`.
- [x] Activity bump re-pulls the thread and overwrites the file (idempotent).
- [x] `progress({ message })` reports start, filter bootstrap (only first run), forward pass count, threads fetched, done.

---

## Phase 2: All four discovery edges + multi-site fan-out

**User stories**: 3, 4, 5

End-to-end demoable: add the rest of the discovery edges and crawl every site listed in `SE_SITES`. A thread touched by multiple edges (e.g. you commented and bookmarked) writes one file with all relevant flags. One collection per site.

**Acceptance:**
- [x] Manifest gains `SE_SITES` env (default `stackoverflow`); plugin parses it and crawls each site independently.
- [x] Manifest's `collections` lists a hardcoded set of common SE sites (`stackoverflow`, `serverfault`, `superuser`, `askubuntu`, `math`, `softwareengineering`, `codereview`, `stats`, `physics`, `tex`, `english`, `apple`). Power users can edit the manifest to add more — the plugin is gitignored under `test.local/`.
- [x] Plugin adds `/me/answers`, `/me/comments`, `/me/favorites` forward calls, one per site.
- [x] Per-edge response → `question_id` set transformation:
  - `/me/questions` → item's `question_id`
  - `/me/answers` → item's `question_id` (each answer object carries it)
  - `/me/comments` → item's `post_id` mapped to its parent question (`post_type === "question"` ⇒ id is the question; `post_type === "answer"` ⇒ batch-resolved via `/answers/{ids}` to get `question_id`)
  - `/me/favorites` → item's `question_id`
- [x] Union per-site, dedup, batched `/questions/{ids}` per site.
- [x] Frontmatter merges discovery flags: `my_question` + `my_answer_ids: [...]` + `my_comment_ids: [...]` + `bookmarked: true` all coexist when applicable.
- [x] Body markers (`**(your question)**`, `**(your answer)**`) appear inline on the user's contributions, derived directly from the per-thread `edges.my_question` / `edges.my_answer_ids` sets populated by the discovery endpoints. (Simpler than `/me?site=…` user-id resolution — the IDs come back to us directly.)
- [x] Per-`(site, endpoint)` cursor keyed entries in `state.cursors`.

---

## Phase 3: Backward backfill + per-run budget

**User stories**: 10

End-to-end demoable: on first run (or whenever `backfill_done = false`), plugin walks the user's full history page by page in the background. Per-run budget caps the work so a single run doesn't melt through quota; subsequent runs continue from where the last one stopped.

**Acceptance:**
- [x] `state.cursors["<site>:<endpoint>"].backfill_page` (integer, default 0) + `backfill_done` (bool, default false) exist for every active (site, endpoint) pair.
- [x] Backward pass uses `?page=N&pagesize=100&order=desc&sort=creation&filter=<state.filter_id>&site=<site>`.
- [x] Per-run budget = 50 calls. Forward pass runs first; budget remainder feeds backward pass; per-site `/questions/{ids}` batches also count against the same budget.
- [x] Truncated-pass cursor non-advance: forward `last_sync` only advances on `drained=true`; backward `backfill_page` only advances by the count of fully-drained pages.
- [x] `has_more === false` on a backward fetch flips `backfill_done = true` for that pair.
- [x] Progress reports per backward page (`"backfill stackoverflow/answers page 4"`) and announces budget exhaustion (`"budget exhausted; N threads deferred to next run"`).

---

## Phase 4: Rate-limit hygiene + smoke tests

**User stories**: 11, 12

End-to-end demoable: plugin survives SE's `backoff` field and quota nearing zero. Self-throttle prevents bursting. Smoke tests catch regressions in body rendering and cursor advance logic.

**Acceptance:**
- [x] Any response carrying a `backoff` field ⇒ `BackoffSignal` thrown → `reschedule({ afterMs: seconds*1000, reason: "se backoff" })` + `Deno.exit(0)` from the top-level catch. State is persisted before exit.
- [x] 429 with `Retry-After` ⇒ `RateLimitSignal` → same treatment with `retryAfterSec*1000`.
- [x] `quota_remaining` ≤ 100 on any response ⇒ `QuotaSignal` → reschedule for next day (`afterMs = 24*60*60*1000`).
- [x] Self-throttle: `client.ts` enforces ≥ 200ms between outbound requests via a module-level timestamp (5 req/s ceiling).
- [x] `render.test.ts` co-located: 3 tests covering h1 title, score-descending answer order, accepted marker, blockquoted comments with author + score, `**(your question)**` + `**(your answer)**` inline markers, and frontmatter omit-when-default rules.
- [x] `cursors.test.ts` co-located: 5 tests covering `applyForward` truncated-pass non-advance + drained advance, `applyBackward` pagesDrained advance, `backfill_done` flip when `backfillDone=true`, no-op when `pagesDrained=0`.
- [x] Tests runnable via `deno test` from the plugin dir (8/8 passing).

---

## Phase log

When starting implementation, this file is `plans/plugin-stackexchange-RUNNING.md`. Work one phase at a time. Stage only my own changes per phase (other agents are working in parallel); never `git stash` or `git reset`. Append a row below after every phase commit. Rename to `plans/plugin-stackexchange.md` when all phases complete.

| commit | summary |
|--|--|
| 2b436cb | Phase 1: walking skeleton — `/me/questions` forward sync on stackoverflow, full thread rendering, filter bootstrap. Plugin code lives under gitignored test.local/. |
| 14a08f2 | Phase 2: all four discovery edges + multi-site fan-out — `discover.ts` per-endpoint ingestion, batched `/answers/{ids}` to resolve answer-comments → question_id, SE_SITES env, per-(site,endpoint) cursors. |
| 9e73e95 | Phase 3: backward backfill + per-run budget — `backwardPass` paginates history by creation date; 50-call shared budget; forward-first / backward-with-remainder; truncated passes don't advance their cursor. |
| c30f77d | Phase 4: rate-limit hygiene + smoke tests — `BackoffSignal` / `RateLimitSignal` / `QuotaSignal` thrown from `client.ts`, caught at top of `plugin.ts` and converted to `reschedule()`. 200ms throttle. 8/8 smoke tests pass. |
