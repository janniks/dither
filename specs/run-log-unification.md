# Run-log unification

> Architectural deepening — merges `journal.ts` and `events-log.ts` behind a single **Run-log** seam.

## Problem Statement

Two parallel append-only JSONL event systems exist in the codebase, each with its own poll-tail loop, schema, rotation policy, and consumer.

- `journal.ts` writes per-**Run** history at `~/.dither/history/<runId>/events.ndjson` with `{type, at, ...payload}`. Consumed by `dither runs list` and `dither runs tail` via a 100 ms poll.
- `events-log.ts` writes daemon-global events at `~/.dither/events.jsonl` with `{ts, kind, ...}`. Consumed by `dither init` via a near-identical 100 ms `fstat`-poll.

Both modules independently implement: open-on-append, file-size tracking, line-buffer chunking, ENOENT tolerance, JSON-parse error tolerance. The two schemas have drifted (`type` vs `kind`, `at` vs `ts`). `events-log.ts` has rotation; `journal.ts` does not. Anyone who wants to display "what the system has been doing" must speak both dialects.

When a new caller wants to watch the daemon and watch a triggered **Run** at the same time — for example a future `dither watch` command, or `dither init --verbose` — they have to consume both feeds and manually interleave them. The two-system shape blocks that.

## Solution

A single **Run-log** module with two scopes:

- **global** — daemon-lifecycle events, **Job** progress, **Reconciler** ticks. One file at `~/.dither/run-log.jsonl`.
- **run** — per-**Plugin**-execution events. One file per **Run** at `~/.dither/history/<runId>/events.jsonl`.

**Q1 decided: (a) two paths, one seam.** The deepening goal is one seam, not one file. Per-**Run** dirs already exist for `manifest.json`/`result.json`; keeping `events.jsonl` alongside them matches existing locality and survives global-log rotation without an index file.

One open/append/poll/rotate primitive serves both scopes. Both share one event schema. Existing call sites move to the new seam in place. Per-**Run** files are renamed to `events.jsonl` (extension follows the new schema; pre-launch, so safe).

`dither runs tail` and `dither init`'s watch loop both call the same `follow(scope, options)` API.

## User Stories

1. As a CLI maintainer, I want one event-log module, so that I do not have to remember which of two dialects a given consumer speaks.
2. As a CLI maintainer, I want one polling implementation, so that a fix to ENOENT-during-rotation behaviour applies to every consumer.
3. As a future feature author, I want to subscribe to global and per-Run events through one interface, so that I can build a `dither watch` view without learning two systems.
4. As a `dither runs tail` user, I want event tailing to feel identical to `dither init`'s watch flow, so that the CLI does not surprise me.
5. As a daemon, I want one routine to append events regardless of scope, so that adding a new event kind is a one-line addition.
6. As a test author, I want one set of test fixtures for the event log, so that I do not duplicate poll-tail testing across two modules.

## Implementation Decisions

### Module shape

- One module replaces both. The deepening goal is _one seam_, not _one file_; the on-disk layout keeps two paths because the scopes have genuinely different lifetimes.
- The module exposes: `append(scope, event)`, `read(scope)`, `follow(scope, onEvent)`, `truncate(scope)`. The `scope` parameter is either `{kind: "global"}` or `{kind: "run", runId}`.
- The poll-tail primitive lives once, parameterised by file path. Both scopes call it.

### Event schema

- One shape: `{ts, kind, scope, runId?, ...payload}`.
  - `ts` is ISO-8601.
  - `kind` is a closed union of every event kind in the system.
  - `scope` is `"global" | "run"`; `runId` is required when `scope === "run"`.
- The previous `EventType` (journal) and `EventKind` (events-log) unions merge into one `EventKind` union. Names that already collided (e.g. `error`) stay as one entry.

### Rotation

**Q3 decided: (a) 1 MB hard truncate, both scopes.** Matches existing `events-log.ts` behaviour; the seam owns one policy. Per-**Run** logs are bounded by run length and almost never reach the threshold; the uniform policy is for predictability, not necessity. No back-file. If preserving daemon-side history ever matters, switching to rotate-with-suffix is local to this module.

### Run-manifest split

**Q4 decided: (a) keep three files.** `manifest.json`, `events.jsonl`, `result.json` describe three different things at three different lifetimes — identity card, event stream, terminal state. Folding them gains module-ownership tidiness at the cost of slower `dither runs list` and more involved crash-mid-run recovery. `RunSummary` (used by `dither runs list`) is composed from `manifest.json` + `result.json` as today.

### Migration

**Q2 decided: no migration.** Pre-launch, no users. The unified module writes the new schema (`{ts, kind, scope, runId?, ...}`) directly. No compat-shim reader for old `events.ndjson` files; no on-the-fly field renaming. Any leftover dev-time history is abandoned in place — readers do not target it.

### Call-site updates

- `daemon.ts`, `daemon-jobs.ts` → `append({kind: "global"}, ...)`.
- `plugin-run.ts` → opens a run scope via `openRun(plugin, trigger)` returning `{runId, append, close}`. `RunJournal` class disappears.
- `commands/init.ts` → `follow({kind: "global"}, handler)`.
- `commands/runs.ts` → `follow({kind: "run", runId}, handler)`.

### Out-of-scope migrations

- No new event kinds are introduced as part of this change.

## Testing Decisions

- Test the **Run-log** seam through its public surface: write events, read them back, observe them via `follow`, assert rotation triggers at the threshold, assert ENOENT during rotation does not drop events.
- Existing tests for `journal.ts` and `events-log.ts` are deleted; their assertions move to the unified module's test file.
- Existing tests in `cli-dispatch.test.ts`, `commands/init.test.ts`, `commands/runs.test.ts` keep their assertions about behaviour; only their setup-fixture imports change.

Prior art: `daemon-jobs.test.ts` already exercises events-log through the `events-log.ts` public surface; the new test file follows the same shape.

## Out of Scope

- Switching from poll-tail to `fs.watch` or `inotify`. The poll is intentional (see existing comment in `journal.ts` about cross-platform `fs.watch` flakiness).
- Adding an HTTP / Unix-socket consumer for the **Run-log**.
- Centralising **Run** manifests + results into the log itself.

## Further Notes

- The dual-scope choice is recorded in `docs/adr/0001-run-log-dual-scope.md` because a future reader will plausibly ask "why didn't you collapse the per-Run dirs into the global log?"
- Sequence: this change is independent of the **DaemonClient seam** spec, but the latter consumes `follow({kind: "global"})` directly, so doing **Run-log unification** first makes the DaemonClient spec simpler.
