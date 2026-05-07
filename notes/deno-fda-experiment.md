---
date: 2026-05-07
tags: [security, macos, plugins, deno]
---

# Deno + FDA: empirical findings, owned-deno experiment

## What we tried

User added FDA to:

- `node` (the dither runtime) → didn't work.
- `deno` (system / brew, the plugin runtime) → didn't work.
- both `node` + `deno` together → didn't work.
- their **terminal app** → worked.

So in this setup, macOS TCC is checking the *responsible process* (terminal) rather than (or in addition to) the running binary's grant. Per-binary grants on `node` / `deno` are silently ignored when the chain is `terminal → shell → node → deno`.

This matches what [`notes/fda-and-the-daemon.md`](./fda-and-the-daemon.md) flagged — the responsibility-chain wall.

## Open question owned-deno can answer

If dither shipped its own deno binary at a stable, dither-controlled path (`~/.dither/bin/deno-<version>` per [`notes/manage-own-deno.md`](./manage-own-deno.md)), would granting FDA to **that** binary work — without granting FDA to the terminal?

Two cases the experiment distinguishes:

- **It works** → TCC was checking the running binary all along, but per-binary grants on `brew`-managed `deno` got invalidated by code-signature drift / path drift. A stable dither-owned path is the fix.
- **It doesn't work** → TCC is strictly checking the responsible process. Owning deno doesn't bypass it. The only durable answer is a launchd-managed daemon (then the responsible process is launchd, and FDA on the daemon binary is honored).

Either outcome unblocks a clear next step.

## Why this matters

If dither stays dependent on terminal FDA, every protected-data plugin (iMessage, Notes, Mail, Photos, Calendar, Reminders, …) requires the user to grant FDA to their terminal — a global escalation we don't want to recommend. Owning deno is a prerequisite for either outcome:

- For the optimistic case, it's the fix.
- For the pessimistic case, it's still required because the daemon needs to spawn a known, stable deno binary that's also FDA-granted in the same TCC database entry as the daemon binary.

## Suggested next step (no spec yet)

Implement [`notes/manage-own-deno.md`](./manage-own-deno.md). On a single test machine:

1. Grant FDA to `~/.dither/bin/deno-<version>` only.
2. Remove FDA from terminal, `node`, `system deno`.
3. Run the iMessage plugin.

If it works: owned-deno is the FDA story for the foreseeable future, daemon is a future-state nicety. If it doesn't: skip directly to the daemon spec; owned-deno still ships as part of that.

## Status

- Workaround in place: terminal FDA (user-rejected as default policy, but useful for development).
- Blocker: no owned-deno yet. The empirical evidence to choose between owned-deno and daemon hinges on building owned-deno first.
- iMessage plugin works in `test.local` runs from an FDA-granted terminal.
