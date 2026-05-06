---
status: draft
---

# iMessage plugin

> Read-only sync of macOS Messages.app `chat.db` into a dither collection. Reference: `test.local/inspiration/imsg/`.

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
