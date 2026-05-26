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
- [ ] `test.local/plugins/stackexchange/{package.json, deno.json, plugin.ts}` exist; plugin loads under the host without errors.
- [ ] Manifest declares `display_name`, `tagline`, `schedule: 0 */6 * * *`, `collections: ["stackexchange/stackoverflow"]`, `net: ["api.stackexchange.com"]`, env entries for `SE_KEY` + `SE_ACCESS_TOKEN`.
- [ ] Missing `SE_KEY` or `SE_ACCESS_TOKEN` throws with a clear message before any HTTP call.
- [ ] On first run, plugin POSTs to `/filters/create` with the desired-fields constant, caches the returned id in `state.filter_id`.
- [ ] Plugin GETs `/me/questions?site=stackoverflow&fromdate=<last_sync>&order=desc&sort=activity&filter=<state.filter_id>&pagesize=100`, paginates via `has_more` + `page`, collects `question_id` set.
- [ ] Plugin batches `/questions/{ids}?site=stackoverflow&filter=<state.filter_id>` (up to 100 ids per call), pulls each thread with nested answers + comments.
- [ ] For each thread, writes `<question_id>.md` to collection `stackexchange/stackoverflow/` with frontmatter (`id`, `site`, `title`, `url`, `tags`, `score`, `answer_count`, `has_accepted`, `my_question: true`, `asked_at`, `last_activity_at`, `captured_at`) and the documented body shape (h1 title, question body, blockquoted comments, `## Answer by … — N ↑` headers sorted by score desc, accepted marker, your-post inline markers).
- [ ] Omit-when-default rule applied (e.g. `my_answer_ids` not emitted when empty).
- [ ] After a clean forward pass, `state.cursors["stackoverflow:questions"].last_sync = run_start_unix`.
- [ ] Activity bump re-pulls the thread and overwrites the file (idempotent).
- [ ] `progress({ message })` reports start, filter bootstrap (only first run), forward pass count, threads fetched, done.

---

## Phase 2: All four discovery edges + multi-site fan-out

**User stories**: 3, 4, 5

End-to-end demoable: add the rest of the discovery edges and crawl every site listed in `SE_SITES`. A thread touched by multiple edges (e.g. you commented and bookmarked) writes one file with all relevant flags. One collection per site.

**Acceptance:**
- [ ] Manifest gains `SE_SITES` env (default `stackoverflow`); plugin parses it and crawls each site independently.
- [ ] Manifest's `collections` is generated to include `stackexchange/<site>` for each listed site (or a hardcoded list of common sites if dynamic collections aren't supported by the manifest schema — verify against host).
- [ ] Plugin adds `/me/answers`, `/me/comments`, `/me/favorites` forward calls, one per site.
- [ ] Per-edge response → `question_id` set transformation:
  - `/me/questions` → item's `question_id` (or `id` field on a question)
  - `/me/answers` → item's `question_id` (each answer object carries it)
  - `/me/comments` → item's `post_id` mapped to its parent question (`post_type === "question"` ⇒ id is the question; `post_type === "answer"` ⇒ need to resolve via the answer's `question_id`, which the filter must include)
  - `/me/favorites` → item's `question_id` (favorites return question objects)
- [ ] Union per-site, dedup, batched `/questions/{ids}` per site.
- [ ] Frontmatter merges discovery flags: `my_question` + `my_answer_ids: [...]` + `my_comment_ids: [...]` + `bookmarked: true` all coexist when applicable.
- [ ] Body markers (`**(your question)**`, `**(your answer)**`) appear inline on the user's contributions, derived from `owner.user_id` on each post matching the authenticated user. (User id resolved once per run via `/me?site=<site>`.)
- [ ] Per-`(site, endpoint)` cursor keyed entries in `state.cursors`.

---

## Phase 3: Backward backfill + per-run budget

**User stories**: 10

End-to-end demoable: on first run (or whenever `backfill_done = false`), plugin walks the user's full history page by page in the background. Per-run budget caps the work so a single run doesn't melt through quota; subsequent runs continue from where the last one stopped.

**Acceptance:**
- [ ] `state.cursors["<site>:<endpoint>"].backfill_page` (integer, default 0) + `backfill_done` (bool, default false) exist for every active (site, endpoint) pair.
- [ ] Backward pass uses `?page=N&pagesize=100&order=desc&sort=creation&filter=<state.filter_id>&site=<site>`.
- [ ] Per-run budget = 50 calls. Forward pass runs first; budget remainder feeds backward pass.
- [ ] Truncated-pass cursor non-advance: if the budget runs out mid-page, `last_sync` (forward) and `backfill_page` (backward) do **not** advance.
- [ ] `has_more === false` on a backward fetch flips `backfill_done = true` for that pair.
- [ ] Progress reports per backward page (`"backfill stackoverflow/answers page 4 (N items, has_more)"`).

---

## Phase 4: Rate-limit hygiene + smoke tests

**User stories**: 11, 12

End-to-end demoable: plugin survives SE's `backoff` field and quota nearing zero. Self-throttle prevents bursting. Smoke tests catch regressions in body rendering and cursor advance logic.

**Acceptance:**
- [ ] Any response carrying a `backoff` field ⇒ `reschedule({ afterMs: backoff*1000, reason: "se backoff" })` + `Deno.exit(0)` immediately. State is persisted before exit.
- [ ] 429 with `Retry-After` ⇒ same treatment.
- [ ] `quota_remaining` ≤ 100 on any response ⇒ reschedule for next day (`afterMs = 24*60*60*1000`).
- [ ] Self-throttle: never more than 5 outbound requests per second in a single run.
- [ ] `render.test.ts` co-located: fixture Q + 2 answers + comments → asserts h1 title, score-descending answer order, accepted marker, blockquoted comments, `**(your answer)**` inline marker.
- [ ] `cursors.test.ts` co-located: asserts first-request shape, truncated-pass non-advance, drained-pass advance, `backfill_done` flip when `has_more === false`.
- [ ] Tests runnable via `deno test` from the plugin dir.

---

## Phase log

When starting implementation, this file is `plans/plugin-stackexchange-RUNNING.md`. Work one phase at a time. Stage only my own changes per phase (other agents are working in parallel); never `git stash` or `git reset`. Append a row below after every phase commit. Rename to `plans/plugin-stackexchange.md` when all phases complete.

| commit | summary |
|--|--|
|  |  |
