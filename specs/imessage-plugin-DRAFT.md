---
status: draft
---

# iMessage plugin

> Read-only sync of macOS Messages.app `chat.db` into a dither collection. Reference: `test.local/inspiration/imsg/`.

## Decisions so far

- **Q1: Layout = per-chat + per-day nested under `messages/<service>/<identifier>/<YYYY-MM-DD>/<message-guid>.md`.**
  - One qmd collection (`messages`) — all the nesting is filesystem-only and qmd's `**/*.md` recursion picks it up.
  - Manifest grant: `messages/**`.
  - Useful sub-grants the user can dial in at install: `messages/imessage/**` (just iMessage), `messages/imessage/+15551234567/**` (one chat), `messages/imessage/+15551234567/2026-05-*/**` (one chat, one month).
  - `<service>` segment: `imessage` or `sms` (lowercased, sanitized).
  - `<identifier>` segment: `chat_identifier` for 1:1 (e.g. `+15551234567`, sanitized to `[a-zA-Z0-9._-]`), or chat GUID for groups (e.g. `chat0000000000`).
  - `<YYYY-MM-DD>` segment: ISO 8601, the host's **local-time** date of the message (per-day granularity confirmed).
  - `<message-guid>.md`: stable filename = the iMessage row's `guid`. Re-runs are idempotent — same guid → same file → overwritten with latest content (covers edits / late-arriving tapbacks).
