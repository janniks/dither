---
status: draft
priority: P2
---

# Slack plugin — spec

## Problem

A meaningful share of a person's working knowledge lives in Slack: 1:1 DMs,
thread decisions, channel discussions, channel-pinned reference links. None
of it is searchable from dither today. Slack's own search is good
in-product but doesn't compose with the rest of a user's markdown library.

Goal: mirror a user's Slack content into the dither library as markdown
documents, one document per meaningful unit (thread, per-day channel,
per-day DM, per-bookmark), pull-only, write-once, on the existing plugin
primitives — no new SDK surface, no host changes.

References (read for inspiration, code not used or executed):

- `rusq/slackdump` — auth pattern (xoxc + d cookie), enterprise-alert
  posture, per-conversation cursor.
- `korotovsky/slack-mcp-server` — `#name` / `@user` resolution, smart
  history limits, lazy user/channel cache.

## Stories

- I had a thread last Tuesday in `#eng-team` about retry budgets. I want to
  find it by content, not by scrolling Slack.
- A friend DM'd me a long-form article 14 months ago. Slack purged it on
  free tier; I want my own copy in markdown.
- My team has a `#design-archive` channel with one bookmark per spec doc.
  I want those bookmarks indexed alongside my Notion exports.
- I leave Slack today. I want every DM and thread I was in still readable
  and grep-able a year from now without Slack.

## Decisions

### Granularity (what's one md file)

- **Per-thread.** Root + all replies = one doc; cross-day threads stay one
  doc.
- **Per-day, per-channel.** Un-threaded channel messages bundle into one
  doc per channel per day.
- **Per-day, per-DM / group-DM.** Same shape as channels; group DMs keyed
  by the sorted participant set.
- **Per-bookmark.** Channel-level URL bookmarks (the header pins) get one
  doc each.
- **No per-message docs**, **no saved-items collection** (the underlying
  messages are already in the channel/thread/DM docs).

### Auth

Hybrid local + paste:

- **`xoxc-` token auto-extracted** from Slack desktop's leveldb at
  `~/Library/Application Support/Slack/Local Storage/leveldb/`. Plugin
  byte-scans the `.log` / `.ldb` files for the `localConfig_v2` JSON, parses
  `teams[...]`, picks the team whose `name` matches `SLACK_WORKSPACE`.
- **`d` cookie pasted by the user** via `dither env set SLACK_COOKIE_D`.
  Can't auto-extract without Keychain access, which needs subprocess or FFI
  — both forbidden by the plugin sandbox. Manual paste keeps the plugin
  pure on existing primitives.
- **One workspace per install.** Two workspaces = install twice
  (`slack-work`, `slack-personal`).
- **No bot tokens**, **no user-token Slack apps**. Just the browser-session
  auth path slackdump pioneered. Sanctioned-by-tolerance; documented
  Enterprise-alert risk; v1 surfaces a warning at install.

### Scope (what gets pulled)

- **Default: everything** the user can see — public channels they're a
  member of, private channels, DMs, group DMs.
- `SLACK_ALLOW` — comma list of channel names or IDs. If non-empty, only
  these.
- `SLACK_DENY` — comma list, applied after allow.
- **No `users.list` calls, ever** (Enterprise-alert vector per slackdump's
  enterprise.md). All user resolution lazy via `users.info`, cached
  forever in state.
- **No `conversations.list` calls**, ever. Membership comes from
  `users.conversations` once per run.

### Cursor & budget

Per-conversation cursors in state:

```ts
state.conversations[conv_id] = {
  head_ts: string,        // newest ts emitted
  backfill_ts: string,    // oldest ts reached during backward pass
  backfill_done: boolean,
  last_polled: string,    // iso
  thread_seen: Record<ThreadTs, number>  // reply_count last seen per thread root
}
```

- Forward: `conversations.history?oldest=head_ts&inclusive=false`.
- Backward (only if `SLACK_BACKFILL=on`): `latest=backfill_ts`.
- Budget split: **60 % forward / 40 % backward** of
  `SLACK_MAX_MESSAGES_PER_RUN` (default 2000).
- Backward pass picks conversations **round-robin by `last_polled`
  ascending**, oldest cursor first.
- Page size clamped to `min(200, remaining_budget)`. Never fetch 200 to
  keep 10.
- Threads re-fetched **only when `reply_count > thread_seen[ts]`**.
- `SLACK_MIN_DATE` (default empty) caps backfill floor.

### Rate limits

- **Global pacer at `SLACK_REQ_PER_MIN` (default 30 req/min)**, enforced in
  one wrapper `slackFetch()`. Below all published Slack tier limits and
  below the empirical xoxc soft-throttle.
- `429` with `Retry-After ≤ 60s`: sleep + retry.
- `429` with `Retry-After > 60s`, or repeated `5xx`: throw, resume next
  run.

### Rendering

- **Mrkdwn → CommonMark**: `*bold*` → `**bold**`, `~strike~` → `~~strike~~`,
  italic / inline code / code blocks / `>quote` already match.
- **`<@U01ABC>`** → `@displayname` (lazy users.info, fall back to `@U01ABC`).
- **`<#C01ABC|general>`** → `#general`.
- **`<https://x|label>`** → `[label](https://x)`. Bare URLs in angle
  brackets unwrap.
- **`<!channel>` / `<!here>`** → `@channel` / `@here`.
- **`:emoji:` kept literal.**
- **Attachments**: link-only. `📎 [filename.pdf](permalink)`. No download.
- **Code snippets**: inlined as fenced code blocks from `file.preview`.
- **Slack "blocks"**: prefer `message.text` (Slack guarantees fallback);
  walk blocks only when `text` is empty.

### What we drop

Following the **content-over-metadata** rule:

- Reactions (👍 counts).
- Edits — we don't refetch `edited.ts`; first observed wins.
- Activity messages — `channel_join`, `channel_leave`, `channel_topic`,
  `channel_purpose`, `channel_name`, `pinned_item`, `reminder_add`,
  `huddle_thread*`.
- `me_message` (`/me waves`).
- Tombstones (`subtype: tombstone`).
- Slackbot messages (always; hardcoded).
- Stars / saved-for-later (the underlying messages are already in
  channel/thread docs).
- Pins (same reasoning).
- Empty messages with no file attachment.

### Bots

- **Bots dropped by default.** `SLACK_INCLUDE_BOTS=false`.
- Set `true` to include all bot output (deploy bots, incident bots, etc.).
  Library-level filtering / deletion is the escape hatch.

### Bookmarks pass

- `bookmarks.list?channel_id=…`, Tier-3 endpoint.
- Refreshed **every 24 h per channel** (state tracks
  `bookmarks_last_refreshed`), not every run.
- Scoped to channels in the live allow/deny set.
- One doc per bookmark, `<channel_id>-<bookmark_id>.md`.

### Failure handling

Throw + clear message + state intact. No backoff schedules in state, no
quarantine files.

| Failure | Action |
|---|---|
| 401 / 403 | throw `auth expired or rejected — re-paste SLACK_COOKIE_D from devtools` |
| per-conv `not_in_channel` | catch + log + skip that conv this run; no kicked-flag in state |
| `429` `Retry-After ≤ 60s` | sleep + retry |
| `429` `Retry-After > 60s` or repeated `5xx` | throw; next run resumes |
| token extract failed | throw with workspace list |
| `state.json` unparseable | throw with `delete state.json to reset` |

### Cadence

- `schedule: hourly`.
- Single run does forward pass → backward pass → bookmarks pass (only for
  channels overdue for refresh).

## Output

### Collections

- `slack/<workspace>/channels/` — per-day channel docs
- `slack/<workspace>/dms/` — per-day DM and group-DM docs
- `slack/<workspace>/threads/` — per-thread docs
- `slack/<workspace>/bookmarks/` — per-bookmark docs

Manifest declares `"collections": ["slack/**"]` (double-star matches the
nested `<workspace>/<bucket>` segments; single `*` would only match one
segment beyond `slack/`).

### Filenames

- Thread: `<channel_id>-<thread_ts_no_dot>.md`
- Channel-day: `<channel_id>-<YYYY-MM-DD>.md`
- DM-day: `<channel_id>-<YYYY-MM-DD>.md`
  (group DM channel_id is the `mpim` `Gxxx…`)
- Bookmark: `<channel_id>-<bookmark_id>.md`

Stable IDs in filenames so channel renames don't fork history. Human
names live in frontmatter.

### Frontmatter (thread)

```yaml
---
collection: slack/mycompany/threads
source: slack
workspace: mycompany
team_id: T01ABC
channel: C01XYZ
channel_name: eng-team
channel_type: channel | im | mpim
thread_ts: "1716200000.012300"
root_author: alice
participant_count: 5
message_count: 23
first_ts: "1716200000.012300"
last_ts: "1716286400.001200"
url: https://mycompany.slack.com/archives/C01XYZ/p1716200000012300?thread_ts=1716200000.012300
---
```

### Body shape

```markdown
### 13:42 — @alice
Hey, did you see the doc?

### 13:43 — @bob
yes — [link](https://...)

### 14:00 — @alice
📎 [retry-budget.pdf](https://mycompany.slack.com/files/U01/F01/retry-budget.pdf)
```

Time is HH:MM in host-local TZ. Each message gets a `### ` heading so
markdown TOC tools see them.

## State

```ts
interface State {
  schema_version: 1;
  workspace: {
    team_id: string;
    team_domain: string;
    users: Record<UserId, { name: string; real_name?: string; deleted?: boolean }>;
    channels: Record<ChannelId, {
      name: string;
      type: "channel" | "im" | "mpim";
      is_archived: boolean;
      bookmarks_last_refreshed?: string; // iso
    }>;
  };
  conversations: Record<ChannelId, {
    head_ts: string;
    backfill_ts: string;
    backfill_done: boolean;
    last_polled: string;
    thread_seen: Record<string, number>;
  }>;
  saved_bookmarks: Record<string, string>; // bookmark_id → updated ts (for re-emit only on change)
}
```

`schema_version` lets us migrate or hard-reset later.

## Manifest

```jsonc
{
  "name": "slack",
  "version": "0.0.1",
  "license": "MIT",
  "dither": {
    "display_name": "Slack",
    "tagline": "Mirror your Slack channels, DMs, threads, and bookmarks as markdown.",
    "collections": ["slack/**"],
    "schedule": "hourly",
    "net": ["slack.com"],
    "env": [
      { "name": "SLACK_WORKSPACE",           "description": "subdomain (e.g. 'mycompany')" },
      { "name": "SLACK_COOKIE_D",            "description": "value of the 'd' cookie from devtools" },
      { "name": "SLACK_ALLOW",   "default": "", "description": "comma-list of channel names/IDs to include. Empty = all." },
      { "name": "SLACK_DENY",    "default": "", "description": "comma-list of channel names/IDs to exclude." },
      { "name": "SLACK_BACKFILL","default": "on", "description": "'on' = two-pointer historic backfill; 'off' = forward-only" },
      { "name": "SLACK_MIN_DATE","default": "", "description": "ISO date floor for backfill, e.g. 2024-01-01" },
      { "name": "SLACK_MAX_MESSAGES_PER_RUN", "default": "2000" },
      { "name": "SLACK_REQ_PER_MIN", "default": "30" },
      { "name": "SLACK_INCLUDE_BOTS","default": "false", "description": "include bot messages (GitHub bot, Statuspage, etc.)" }
    ],
    "files": [
      { "id": "SLACK_LEVELDB", "kind": "folder", "required": true,
        "description": "Slack desktop's leveldb dir, e.g. ~/Library/Application Support/Slack/Local Storage/leveldb" }
    ]
  }
}
```

## Plugin layout (test.local/plugins/slack/)

```
test.local/plugins/slack/
  package.json     # manifest above
  plugin.ts        # entry: orchestrates forward / backward / bookmarks passes
  auth.ts          # leveldb byte-scan for xoxc token, workspace match
  api.ts           # slackFetch — pacer, 429 handling, auth header (token + cookie)
  state.ts         # State shape + readState/writeState helpers
  cursor.ts        # forward + backward + budget split + round-robin picker
  render.ts        # mrkdwn → CommonMark, mention/channel resolution, body shape (pure)
  filters.ts       # subtype + bot drop rules (pure)
  bookmarks.ts     # bookmarks.list pass
  README.md        # install + devtools snippet for the d cookie
```

Pure modules (`render`, `filters`, `cursor`) take inputs and return data;
I/O lives in `plugin.ts`, `api.ts`, `auth.ts`, `state.ts`, `bookmarks.ts`.

## Install UX

1. `dither env set SLACK_WORKSPACE mycompany`
2. `dither env set SLACK_COOKIE_D <d-cookie-from-devtools>`
3. `dither plugin install test.local/plugins/slack \
     --allow-env SLACK_WORKSPACE,SLACK_COOKIE_D,SLACK_ALLOW,SLACK_DENY,SLACK_BACKFILL,SLACK_MIN_DATE,SLACK_MAX_MESSAGES_PER_RUN,SLACK_REQ_PER_MIN,SLACK_INCLUDE_BOTS \
     --files SLACK_LEVELDB=~/Library/Application\ Support/Slack/Local\ Storage/leveldb`
4. `dither plugin run slack` (or wait for the hourly tick).

README contains the devtools snippet for extracting `d`:

```javascript
document.cookie.split(';').find(c=>c.trim().startsWith('d=')).split('=')[1]
```

(Doesn't work — `d` is HttpOnly; user copies from Application → Cookies →
`slack.com` in devtools manually. README states this plainly.)

## Out of scope (v1)

- File downloads (link-only attachments instead).
- `users.list` / `conversations.list` (Enterprise-alert risk).
- Saved-for-later, pins (subsumed by normal channel/thread sync).
- Reactions, edits, activity events, /me messages (content-over-metadata).
- Search via `search.messages`.
- Sending messages.
- Multi-workspace per install (install twice).
- Windows / Linux token auto-extract (paths differ; macOS-only v1).
- Host-side `dither slack auth` keychain wizard (could land later; v1 stays
  on existing primitives).
- Slack Connect / shared external channels — currently treated as normal
  channels with whatever visibility the user has.

## Acceptance criteria

- [ ] Manifest validates and installs on a clean dither.
- [ ] `dither plugin run slack` on a small workspace (≤ 5 channels, ≤ 20
      DMs, ≤ 90 days of history) finishes in ≤ 5 minutes wall-clock, ≤ 100
      Slack API calls, no `users.list` / `conversations.list` in the
      access log.
- [ ] Forward pass picks up new messages within one hourly tick of being
      sent.
- [ ] Backward pass with `SLACK_BACKFILL=on` converges to either
      `backfill_done=true` or `MIN_DATE` for every conversation, without
      bursting past `SLACK_REQ_PER_MIN`.
- [ ] Re-running on top of existing entries does not produce duplicate
      filenames or duplicate content; thread doc re-emits as new replies
      arrive.
- [ ] All four collections (`channels`, `dms`, `threads`, `bookmarks`)
      populate on a workspace that contains examples of each.
- [ ] Bot messages, activity messages, `me_message`, and Slackbot are
      absent from the output.
- [ ] Auth-expired (rotated `d` cookie) produces a single clear error on
      next run; state untouched; re-pasting cookie resumes sync at the
      next tick with no loss.
- [ ] Plugin runs under the existing plugin sandbox (no `--allow-run`, no
      `--allow-ffi`, no host changes).

## Related notes

- `notes/sandbox-trust-model.md` — sandbox guarantees this plugin relies
  on (no subprocess / FFI, env grant, net allowlist).
- iMessage plugin (`test.local/plugins/imessage/`) — closest existing
  pattern (two-pointer cursor, lazy resolution, idempotent re-emit). This
  spec is "iMessage but over Slack's network API instead of `chat.db`."
- Reference clones (read-only, not run):
  - `rusq/slackdump` at `/var/folders/.../slackdump-ref-XXXX.Yc2M9bN7Z9`
  - `korotovsky/slack-mcp-server` at `/var/folders/.../slack-mcp-ref-XXXX.BVf4CrRCXk`
