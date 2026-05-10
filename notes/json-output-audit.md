---
status: thinking
priority: P2
---

# `--json` audit across dither commands

## Why

For agentic / scripted use, every read-shaped command should support
`--json` so callers can pipe structured output into other tools without
parsing human-readable text. Some commands have `--json` today
(`status`, parts of `search`); others don't. Worth one pass through
the surface to make this consistent.

## What to audit

For each command, decide:
- Does it return data the caller might want to consume? (Yes for
  list/get/status; usually no for mutating commands.)
- If yes, does it have `--json` today?
- If yes, does the JSON shape match the human output? (Same fields,
  no surprise omissions.)
- If no, add `--json`.

## Commands to walk

From `dither --help`:

- `init` — write-side. JSON optional (return the saved `DitherConfig`
  on success; current shape probably already returnable).
- `search` — read. Has lex/hybrid output today; verify `--json` flag
  exists and emits hits as a JSON array consistently.
- `get` — read. Should emit the entry's frontmatter + body as JSON
  (`{ frontmatter: {...}, body: "..." }`) when asked.
- `plugin install` — write. JSON optional (return resolved grants).
- `plugin run` — write but informational. JSON returns `{ runId,
  promoted: [...] }`. Probably already does.
- `plugin list` — read. Each plugin's manifest + install state. **Add
  `--json` if missing.**
- `plugin uninstall` — write. JSON optional (return removed plugin id).
- `env set/get/list/rm` — `list` + `get` are read. **Add `--json`.**
- `index update` — write but informational. Returns `UpdateSummary`.
  Probably easy to JSON.
- `runs list/show` — read. List of run records, individual run
  journal. **Add `--json`** so external tools can monitor.
- `daemon status/start/stop/run` — `status` should JSON; current
  `dither status` already does. The daemon-specific subcommand status
  needs a check.
- `status` — already has `--json` (just spec'd cleanup).

## Conventions to lock down during the pass

- `--json` flag name (not `-j` to keep room for future flags).
- JSON output always to stdout; human output to stdout; errors to
  stderr regardless of mode.
- No mixed JSON + human output. `--json` ⇒ exactly one JSON value
  printed; nothing else (no progress, no banners).
- Stable schema documented in each command's `--help` (or in `docs/`).
- Exit codes consistent: 0 for success, non-zero for error. JSON mode
  doesn't change exit semantics.
- `--json` always exits with the JSON written *before* exit, even on
  empty results (e.g. `[]` for empty lists, `{}` for empty objects).
  No silent absence of output.

## Out of scope

- A custom JSON shape per consumer (Linear, Slack, etc.) — those build
  on the canonical `--json`.
- Streaming JSON output (NDJSON for `runs show`?) — defer; one JSON
  value per invocation is the contract for now.
- Schema versioning. If a command's JSON shape changes, callers
  re-read; we'll add a `schema_version` field if/when that gets painful.

## Action

Single PR or small series:
- For each command without `--json`, add the flag + minimal JSON
  shape mirroring the human output.
- For each command *with* `--json`, audit: same fields? errors stay
  on stderr? non-zero exit on error?
- Update `dither <cmd> --help` strings to mention `--json` on every
  read command.
- Document the conventions in `docs/agentic-use.md` (or similar) so
  callers have a single page to read.

Schedule: one focused day; not load-bearing on any other feature.
