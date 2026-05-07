# iMessage plugin

> Read-only sync of macOS Messages.app `chat.db` into a dither collection. Reference: `test.local/inspiration/imsg/`.

## Problem Statement

A user's iMessage history is one of the highest-density personal corpora on a Mac — years of conversations with everyone they know — but it lives in an opaque Apple SQLite DB and isn't searchable from agent flows. The user wants to sync it into dither (markdown + qmd index) so it's queryable alongside notes, mail, and other sources, without modifying Messages.app's behavior or signaling Apple's iMessage infrastructure.

## Solution

A dither plugin reads `~/Library/Messages/chat.db` directly via pure-WASM SQLite (sql.js), promotes one markdown entry per text message into a nested `messages/<service>/<chat>/<date>/<guid>.md` layout, and uses a two-pointer cursor (head + backfill) to combine "stay current with new messages" and "chew through history" in the same scheduled run. Read-only by sandbox construction; no Apple framework, no subprocess, no network. Tapbacks, attachments, and Contacts resolution are explicit non-goals for v0.

## User Stories

1. As a user, I want my iMessage history searchable in dither so agents can recall past conversations.
2. As a user, I want new messages to appear in dither soon after they arrive in Messages.app.
3. As a user, I want the historical backfill to happen incrementally without blocking forward sync.
4. As a user, I want to scope the plugin's writes to one chat or a date range, so I can opt in selectively.
5. As a privacy-conscious user, I want assurance that the plugin does not modify `chat.db`, doesn't reach Apple, and can't sidestep these constraints.
6. As a user with a noisy chat, I want per-day folders so a single chat doesn't produce one huge directory.
7. As a maintainer, I want clear cursor state so I can reset or inspect sync progress between runs.

## Notes / future work

- **FFI in the sandbox** — revisit later. Today plugins are denied `--allow-ffi`, which is what forces pure-WASM SQLite. Allowing FFI for _some_ plugins (selectively granted, like net) would unlock native SQLite, image libs, etc. Open question: how to scope the grant (per binary path? per plugin allowlist? user-confirmed at install?). Not in scope for the iMessage plugin; flag for a future grants iteration.

## Decisions so far

- **Q1: Layout = per-chat + per-day nested under `messages/<service>/<identifier>/<YYYY-MM-DD>/<message-guid>.md`.**
  - One qmd collection (`messages`) — all the nesting is filesystem-only and qmd's `**/*.md` recursion picks it up.
  - Manifest grant: `messages/**`.
  - Useful sub-grants the user can dial in at install: `messages/imessage/**` (just iMessage), `messages/imessage/+15551234567/**` (one chat), `messages/imessage/+15551234567/2026-05-*/**` (one chat, one month).
  - `<service>` segment: `imessage` or `sms` (lowercased, sanitized).
  - `<identifier>` segment: `chat_identifier` for 1:1 (e.g. `+15551234567`, sanitized to `[a-zA-Z0-9._-]`), or chat GUID for groups (e.g. `chat0000000000`).
  - `<YYYY-MM-DD>` segment: ISO 8601, the host's **local-time** date of the message (per-day granularity confirmed).
  - `<message-guid>.md`: stable filename = the iMessage row's `guid`. Re-runs are idempotent — same guid → same file → overwritten with latest content (covers edits / late-arriving tapbacks).
- **Q2: SQLite via pure-WASM, declared as a normal plugin dependency.** Plugin `package.json` declares `"dependencies": { "sql.js": "^1.x" }` (or the official `@sqlite.org/sqlite-wasm`). The iMessage plugin itself does the SQLite work; the host does not learn the schema.
- **Dep resolution becomes a host responsibility at install/run time.** Modeled on `npm install`, but using Deno's safe semantics: parse plugin imports, fetch all modules (npm:, jsr:, http(s):, etc.) into Deno's local cache. No lifecycle scripts ever run. This step has network access (any source). Run-time stays offline-capable; we just need the run-time spawn to have `--allow-read` covering Deno's cache dir so the plugin can load cached modules.
  - Implication: a small companion spec for "plugin dependencies" (cache step at install, cache-dir on `--allow-read` at run). Tracked separately; iMessage spec assumes it lands.
- **Q3: Cursor = global ROWID + lookback window.** Plugin state tracks one `since_rowid` (highest `message.ROWID` promoted). Each run reads `WHERE ROWID > since_rowid - LOOKBACK`. Lookback default 200, configurable via env `MESSAGES_LOOKBACK`, set to `0` to disable. Re-emits in the lookback are idempotent (same GUID → overwrite same file).
- **Tapbacks / reactions are out of scope.** Plugin filters them out at query time via `WHERE (associated_message_type IS NULL OR associated_message_type < 2000 OR associated_message_type > 3006)` (the same filter `imsg` uses). Only text-bearing rows are promoted.
- **Known limitation: unsends.** When a user unsends a message in Messages.app the row is deleted. The plugin does not currently reconcile deletions — the previously-promoted entry stays in dither. Document; out of scope for v0.
- **Q4: Attachments — skip for v0.** No frontmatter `attachments[]`, no file copies, no metadata. The attachments model needs more thought (what gets copied, where, how it joins back to entries) and that thinking happens in a separate spec. The iMessage plugin's body field will simply be the message text; if an iMessage row has no `text` (attachment-only message), the plugin emits an empty-body entry whose frontmatter records the row's existence — or skips it entirely (decide at implementation time; either is reversible).
- **Q5: Two-pointer sync, forward-first elastic budget.** State carries `head_rowid` (forward cursor) and `backfill_rowid` (backward cursor). Each run does a forward pass first (new messages, with lookback per Q3), then spends the remainder of `MAX_MESSAGES_PER_RUN` on a backward pass (oldest unprocessed rows down to ROWID 1 or `MIN_DATE`). Forward is cheap and time-sensitive; backward is bulk and time-insensitive. Backfill progress reported via `progress({ message: "backfill 1450 / ~80000 (1.8%) — at 2024-09-12" })`, computed against a `backfill_total` cached on the first run.

## Safety / non-interference with Messages.app

The iMessage plugin reads `chat.db` only. Three things keep it from interfering with Messages.app's normal operation or alerting Apple's iMessage infrastructure:

1. **Read-only by sandbox construction.** The plugin's `files[]` grant for `~/Library/Messages` is `kind: "folder"` and the host adds it to Deno's `--allow-read` only. The plugin has no write permission to the Messages folder, its sidecars, or its WAL. It physically cannot mutate `chat.db`, mark messages as read, edit read receipts, or alter sync state.
2. **No subprocess, no FFI, no Apple frameworks.** Deno's `--allow-run` and `--allow-ffi` are never granted to any plugin. The iMessage plugin cannot shell out to `osascript`, link IMCore, talk to `imagent`, or use any Apple framework that signals iMessage servers. Pure WASM SQLite is the only mechanism it touches `chat.db` through.
3. **No network access to Apple endpoints.** Plugin's `net` grant lists nothing related to Apple/iMessage; there's no path for telemetry or out-of-band signaling. (Plugin may need `--allow-net` only for one-time dep fetch at install — by then the iMessage data isn't loaded yet.)

The plugin reads the SQLite bytes into sql.js's in-memory database, runs queries, exits. It does not hold a file lock on `chat.db` (sql.js operates on a byte-buffer copy). It does not interact with the Apple Messages framework at any layer.

Documentation note for users: this is "scrape your own local DB," not "scrape iMessage." The traffic Apple's servers see is identical with or without dither installed. There is no behavior the plugin can perform that Messages.app would not perform anyway, because the plugin has no path to Apple at all.

## Manifest + grants (Q6)

```jsonc
{
  "name": "imessage",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "dependencies": {
    "sql.js": "^1.11.0",
  },
  "dither": {
    "display_name": "iMessage",
    "tagline": "Sync your local Messages.app history into dither (read-only).",
    "schedule": "*/15 * * * *",

    "env": [
      {
        "name": "MAX_MESSAGES_PER_RUN",
        "default": "2000",
        "description": "Cap rows promoted per run (forward + backward total).",
      },
      {
        "name": "LOOKBACK",
        "default": "200",
        "description": "Re-scan this many rows below head each run for late edits.",
      },
      {
        "name": "MIN_DATE",
        "default": "",
        "description": "Skip messages older than this ISO date (YYYY-MM-DD). Empty = full history.",
      },
    ],

    "files": [
      {
        "id": "MESSAGES_DIR",
        "kind": "folder",
        "required": true,
        "description": "Path to your Messages library, typically ~/Library/Messages.",
      },
    ],

    "collections": ["messages/**"],
  },
}
```

Typical install:

```bash
dither plugin install ./test.local/plugins/imessage \
  --file MESSAGES_DIR=~/Library/Messages
```

- Schedule: `*/15 * * * *` (manifest default; stored, not runtime-enforced until the daemon ships).
- `MESSAGES_DIR` declared as a `files[]` folder grant — host adds it to `--allow-read`. Forces explicit user consent. (No `default` on file inputs today; revisit in a sibling spec.)
- No `net`, no `envRefs`. Plugin is offline at run time (after the install-time dep cache).

## Frontmatter + body (Q7)

Each promoted entry:

```yaml
---
id: <message-guid> # SDK uses this as the filename
source: imessage # auto-stamped
collection: messages/imessage/+15551234567/2026-05-06 # auto-stamped

# Identity / routing
service: imessage # "imessage" or "sms"
chat_identifier: "+15551234567"
chat_guid: "iMessage;-;+15551234567"
is_group: false
participants: ["+15551234567", "+14155551111"] # raw handles, no Contacts

# Sender
sender: "+15551234567" # the handle that sent it; null when is_from_me
is_from_me: false

# Timing
sent_at: "2026-05-06T11:14:23Z" # iMessage `date`, normalized to ISO UTC
sent_at_local: "2026-05-06T13:14:23+02:00" # same instant in host-local TZ

# Provenance
external_id: <message-guid>
external_source_path: "~/Library/Messages/chat.db"
rowid: 91842 # diagnostics, used by lookback / cursor logic

# Extracted content
urls: ["https://example.com/foo", "https://other.com/bar"]
---
<the raw `text` column of the message row, verbatim>
```

- **No Contacts resolution.** iMessage's `chat.db` only carries raw handles (`+15551234567`, `tom@example.com`); macOS Contacts is unreachable from the Deno sandbox (no FFI, no AddressBook framework). All names in path segments and frontmatter are raw handles. A separate plugin or post-processor can layer name resolution later.
- **Body = plain text.** No header wrapper, no markdown decoration. Whatever the message row's `text` column contains, verbatim. (If `text` is null — typical attachment-only message — the plugin skips that row entirely; revisit when attachments are designed.)
- **`urls[]` extracted into frontmatter.** Best-effort regex over the body text to surface URLs as a structured field, indexable via qmd metadata search. The body itself remains unchanged (no markdown auto-link). If extraction is ambiguous on a borderline string, err on the side of inclusion.

## Modules (single small Deno program)

The plugin is small. Three files, no internal abstraction layers:

- **`plugin.ts`** — orchestrator. Reads `input.json`, opens DB, computes initial state on first run, runs forward pass + backward pass under the per-run budget, calls `progress({ message })` between batches, persists state, exits.
- **`db.ts`** — opens `chat.db` via sql.js and exports the SQL queries we need: `headRowid`, `forwardPage`, `backwardPage`, `countBackfill`. The reaction filter (`associated_message_type < 2000 OR > 3006`) lives here.
- **`render.ts`** — pure: row → `EntryOptions`. Builds the path identifier (sanitize, ISO-day, etc.), normalizes Apple's nanosecond-since-2001 epoch to ISO UTC + ISO local, extracts `urls[]` from text. No I/O.

## Testing Decisions

No test additions to dither's test suite. The plugin lives in `test.local/plugins/imessage/` (gitignored) and is exercised by hand against the real `~/Library/Messages/chat.db`. This is an exploratory v0; iterate on the real data, then promote to a permanent home with proper tests when stable.

## Out of Scope

- Tapbacks, reactions, sticker effects, send-style effects.
- Attachments (no file copy, no metadata, no body inlining).
- Contacts-resolved names (raw handles only in path + frontmatter).
- Sending, tapback authoring, message editing, message deletion reconciliation (unsends do not propagate to dither).
- Live watch / file-event triggers. Schedule-driven only.
- Sub-tree search affordances on top of the nesting (use qmd's recursive glob).
- Adding the iMessage plugin to dither's test suite or fixtures directory.

## Further Notes

- The "two-pointer + per-run budget" pattern generalizes; a future "API backfill" plugin (Twitter archive, Gmail, etc.) would benefit from the same cursor abstraction lifted into a shared lib if a second plugin needs it.
- The host-side "plugin dependencies" feature (cache pre-warm at install + Deno cache dir on `--allow-read`) is a soft prerequisite; until it lands, the plugin needs either a one-time `deno cache plugin.ts` outside the host or a temporary `--allow-net` grant for the npm fetch on first run. Manageable for `test.local`.
