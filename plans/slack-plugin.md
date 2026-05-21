# Plan: Slack plugin

> Source spec: `specs/slack-plugin.md`

## Architectural decisions

- **Plugin location**: `test.local/plugins/slack/` — pure-Deno, single dir,
  matches `imessage` layout (`plugin.ts` + helpers).
- **One workspace per install** — singular `SLACK_WORKSPACE` env. Two
  workspaces = install twice.
- **Auth**: `xoxc-` token auto-extracted from Slack desktop's leveldb
  (`~/Library/Application Support/Slack/Local Storage/leveldb/`, granted as
  `files[].SLACK_LEVELDB`); `d` cookie pasted by user (`SLACK_COOKIE_D`).
- **State** (`state.json`): per-conversation cursors + lazy
  user/channel cache + `thread_seen` reply counts + bookmark refresh
  timestamps. Single file, atomic write.
- **Net allowlist**: `slack.com` only. No `files.slack.com` (link-only
  attachments).
- **Collections**: `slack/<workspace>/{channels,dms,threads,bookmarks}`.
  Manifest declares `["slack/*"]`.
- **Cadence**: `schedule: "hourly"`. Manual run via
  `dither plugin run slack` always available.
- **Sandbox**: stays on existing primitives — no `--allow-run`,
  no `--allow-ffi`, no host changes.

---

## Phase 1: Hello-Slack

**User stories**: foundational — proves the auth + transport works end-to-end.

End-to-end behavior:

- Plugin installs against a manifest with `SLACK_WORKSPACE`, `SLACK_COOKIE_D`
  envs and `SLACK_LEVELDB` folder grant.
- `auth.ts` byte-scans the leveldb dir for `localConfig_v2` JSON, parses
  `teams[...]`, picks the team whose `name` or `domain` matches
  `SLACK_WORKSPACE`. If not found, throws with a list of teams that *were*
  found.
- `api.ts` builds a `slackFetch()` that sends `Authorization: Bearer <xoxc>`
  + `Cookie: d=<cookie>` to `https://slack.com/api/<method>`, honors
  `Retry-After`, paces at `SLACK_REQ_PER_MIN`.
- Plugin calls `auth.test` once, emits one md to `slack/<workspace>/`
  with workspace + user identity + extracted-at timestamp.

**Acceptance:**
- [ ] Plugin installs cleanly against an empty `~/.dither`.
- [ ] Run against a real workspace produces exactly one md file with the
      workspace name and authed user.
- [ ] Wrong `SLACK_WORKSPACE` throws with a clear "found teams: …" message.
- [ ] Missing or bad cookie throws with a "re-paste SLACK_COOKIE_D" message.
- [ ] No `users.list`, no `conversations.list` calls.

---

## Phase 2: Forward sync (DMs + channels + filters)

**User stories**: "I want today's DMs and channels readable as markdown."

End-to-end behavior:

- `users.conversations` once per run → list of conversations user is in.
- `SLACK_ALLOW` / `SLACK_DENY` filter applied to that list.
- For each conv: `conversations.history?oldest=head_ts&inclusive=false`,
  page size `min(200, remaining_budget)`, advance `head_ts` per message.
- `render.ts` renders messages: mrkdwn → CommonMark, mentions/channel refs
  resolved via lazy `users.info` cache, link-only attachments.
- `filters.ts` drops: activity subtypes, `me_message`, tombstones,
  Slackbot, all bots (unless `SLACK_INCLUDE_BOTS=true`), empty-with-no-file.
- Per-day doc per conv, idempotent overwrite by filename.
- State commits per-conv `head_ts` and `last_polled`.

**Acceptance:**
- [ ] Per-day docs appear in `slack/<workspace>/dms/` and
      `slack/<workspace>/channels/` for the last N hours of activity.
- [ ] Filenames are stable (`<channel_id>-<YYYY-MM-DD>.md`); re-running
      overwrites cleanly with no duplicates.
- [ ] `SLACK_ALLOW=foo,bar` limits emission to those channels.
- [ ] `SLACK_DENY=noisy-channel` excludes that channel even if in allow.
- [ ] Slackbot DMs absent. Bot messages absent by default.
- [ ] `SLACK_INCLUDE_BOTS=true` includes bot messages.
- [ ] `:emoji:` literal preserved; `<@U…>` resolved to `@displayname` or
      falls back to raw id; `<#C…|name>` → `#name`.

---

## Phase 3: Threads

**User stories**: "I want each thread as its own readable doc."

End-to-end behavior:

- During forward pass, when a message has `reply_count > 0` and
  `reply_count > state.conversations[c].thread_seen[ts]`,
  call `conversations.replies` and emit a thread doc to
  `slack/<workspace>/threads/`.
- Thread doc contains root + all replies in order, frontmatter with
  participant_count, message_count, first_ts, last_ts.
- Thread `head_ts` is the thread's *root* `ts`; we re-emit the doc each
  time new replies push `reply_count` higher.
- Channel-day doc still contains the thread root (with a parenthetical
  `(thread with N replies — see thread doc)` line under it, to avoid
  duplicating the whole thread body in two places).

**Acceptance:**
- [ ] A channel with one thread produces one channel-day doc + one thread
      doc; the channel-day doc shows the root with a "thread of N" pointer.
- [ ] Adding a new reply to a tracked thread on next run causes the thread
      doc to re-emit with the new message; channel-day doc is unchanged.
- [ ] Threads with replies but no further growth are not re-fetched
      (`thread_seen[ts]` gates the call).
- [ ] Thread filename `<channel_id>-<thread_ts_no_dot>.md` is stable.

---

## Phase 4: Backward backfill

**User stories**: "I want my Slack history (months or years) pulled in over
multiple runs without bursting."

End-to-end behavior:

- `SLACK_BACKFILL=on` (default): after forward pass, backward pass uses
  `latest=backfill_ts` per conv.
- Budget split: `0.6 * MAX_MESSAGES_PER_RUN` to forward,
  `0.4 * MAX_MESSAGES_PER_RUN` to backward.
- Backward picks conversations round-robin by `last_polled` ascending —
  staleness-first fairness.
- `SLACK_MIN_DATE` floor: stop backfilling a conv once `backfill_ts <
  MIN_DATE`.
- When `conversations.history` returns no older messages, mark
  `backfill_done: true` and skip on future runs.
- Threads encountered during backward pass also fan out (same path as
  Phase 3).

**Acceptance:**
- [ ] First-run backward pass on a small workspace fills `dms/` and
      `channels/` with historic days.
- [ ] Multiple runs converge: every non-done conv either hits
      `backfill_done` or `MIN_DATE` after enough runs.
- [ ] No single conv monopolizes the backward budget (round-robin
      enforced).
- [ ] `SLACK_BACKFILL=off` cleanly skips the backward pass.
- [ ] `SLACK_MIN_DATE=2025-01-01` halts backfill at that date.

---

## Phase 5: Bookmarks

**User stories**: "I want channel-pinned URL bookmarks indexed alongside
my Notion exports."

End-to-end behavior:

- After forward/backward, for channels in the live allow/deny set whose
  `bookmarks_last_refreshed` is > 24h ago (or never), call
  `bookmarks.list?channel_id=…`.
- For each bookmark: emit one md to `slack/<workspace>/bookmarks/` with
  filename `<channel_id>-<bookmark_id>.md`. Frontmatter: title, link,
  emoji, created/created_by/updated, channel_name.
- Body: title + link.
- Stamp `bookmarks_last_refreshed` per channel in state.

**Acceptance:**
- [ ] Channels with bookmarks produce one md per bookmark.
- [ ] Re-running within 24h does not re-call `bookmarks.list` for the same
      channel.
- [ ] Re-running after 24h re-fetches; unchanged bookmarks idempotently
      overwrite same file.

---

## Phase 6: Failure-mode polish

**User stories**: "When my cookie expires or Slack rate-limits me, the
plugin tells me clearly and doesn't corrupt my library."

End-to-end behavior:

- `slackFetch()` returns `{ ok: false, error }` on Slack API-level errors;
  `401/403` (or `invalid_auth` / `not_authed`) throws with a single clear
  message.
- `429` with `Retry-After ≤ 60s` sleeps + retries.
- `429` with `Retry-After > 60s` throws; state intact at last checkpoint.
- `5xx` after one retry throws; same.
- Per-conv `not_in_channel` / `channel_not_found` errors are swallowed,
  logged via `progress()`, the conv is skipped *this run only*.
- State `state.json` unparseable → throw with `delete state.json to reset`
  (no auto-quarantine).

**Acceptance:**
- [ ] Rotated cookie produces a single clear error per run; no partial
      writes; library untouched.
- [ ] Forced 429 (via `SLACK_REQ_PER_MIN=1000` against a small workspace)
      pauses cleanly and resumes.
- [ ] Removing self from a channel mid-sync → that conv is skipped on
      next run; other convs still progress.
- [ ] Manually corrupting `state.json` produces the documented
      "delete to reset" error.

---

## Phase log

When starting implementation, rename this file to
`./plans/slack-plugin-RUNNING.md`. Work one phase at a time, ticking each
phase's acceptance criteria as satisfied. Commit per phase. Append a row
below after every phase. Rename back to `./plans/slack-plugin.md` when
all phases complete.

| commit | summary |
|--|--|
| 18d322e | Phase 1 — auth (leveldb byte-scan + workspace match) + slackFetch (pacer + 429) + plugin.ts orchestrator emits `workspace.md`; manifest + deno.json + README. |
| (no SHA — test.local) | Phase 2 — `state.ts` per-conv cursor + user/channel caches; `render.ts` mrkdwn→CommonMark + mentions/channel/emoji/files; `filters.ts` activity / Slackbot / bots-by-default drop; `cursor.ts` forward pass with per-day re-fetch model; `plugin.ts` users.conversations + allow/deny + round-robin sort. Type-clean. |
| (no SHA — test.local) | Phase 3 — `cursor.ts` thread fan-out (fetchReplies on `reply_count > thread_seen[ts]`); `render.ts` `threadFilename`, `threadPointer`, `permalink` helpers; `plugin.ts` thread emit with root-author resolution + participant count + permalink in frontmatter; channel-day docs gain pointer line under thread roots. |
| (no SHA — test.local) | Phase 4 — `cursor.ts` `backward()` pass with `seedBackfill()` helper and shared `fanThreads()` between forward + backward; `plugin.ts` first-run head_ts seed to "now", 60/40 forward/backward budget split, round-robin backward by `last_polled` ascending with per-conv slice, `SLACK_MIN_DATE` floor, `SLACK_BACKFILL=off` honored. |
| (no SHA — test.local) | Phase 5 — `bookmarks.ts` channel-only `bookmarks.list` pass, 24h-per-channel `bookmarks_last_refreshed` cadence, one md per bookmark with title + link + emoji frontmatter; `plugin.ts` invokes after forward + backward. |
| (no SHA — test.local) | Phase 6 — `api.ts` single retry on 5xx with 2s backoff (retries counter param); `plugin.ts` `loadState()` wrapper rethrows JSON.parse failures as `state.json is unparseable; delete it to reset and re-run`. All structural failure paths code-complete. |
