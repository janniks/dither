## Problem Statement

Two related papercuts around plugin runs:

- **Command placement.** `dither runs` lives at the top level next to `dither plugin`, `dither init`, `dither search` etc. Runs only exist because plugins fire — but a user reading `dither --help` sees `runs` as a peer of `plugin` with no signal that one drives the other. `dither plugin run` (singular, fire) and `dither runs` (plural, inspect) are split across two namespaces.
- **Lookup ergonomics.** `dither runs tail` requires a full run id like `20260522T141533-bluesky-9f3a1c2e`. The user almost always wants "the last run of bluesky" — the id is just a stepping stone.
- **Wording.** The codebase says a plugin run **promotes** content — event kind `"promoted"`, fields `promoted: string[]` / `promotedCount`, CLI output `"3 promoted"`. "Promoted" is internal jargon: it names the staging→library copy step, not a concept the user cares about. From the user's seat the plugin **added** documents.

## Solution

Move the inspection commands under `plugin`, collapse the `list`/`tail` split into a single positional, let the positional name a plugin (resolved to its most-recent run) instead of forcing a run id, and rename every user-visible "promoted" surface to "added".

After this change:

- `dither plugin run <name>` — fire (unchanged).
- `dither plugin runs` — list recent runs across every plugin.
- `dither plugin runs <runid>` — tail/replay that specific run.
- `dither plugin runs <name>` — tail/replay the most-recent run of that plugin.
- The list and the tail's result line use `added` instead of `promoted`.

The top-level `dither runs` command goes away — no alias, no deprecation shim.

## User Stories

1. As a plugin author, I want `dither plugin run <name>` and `dither plugin runs <name>` to live next to each other, so the fire-vs-inspect verbs share one namespace.
2. As a user debugging a flaky plugin, I want to type `dither plugin runs bluesky` and immediately see the last run's events + result, without first running `dither plugin runs` to copy the id.
3. As a user, I want `dither plugin runs` with no argument to list recent runs across all plugins, so I can pick one to drill into.
4. As a user, I want a clear error when I pass a plugin name with no recorded runs (e.g., "no runs yet for `bluesky` — try `dither plugin run bluesky`").
5. As a user, I want `dither plugin runs <runid>` to behave exactly like the old `dither runs tail <runid>` — past events replayed, then either the `_result` line if finished or a live tail if still running.
6. As a user who uninstalled a plugin but kept its history, I want `dither plugin runs <name>` to still resolve to the last surviving run directory, so removal doesn't blank my history view.
7. As a script author, I want the runid-vs-name disambiguation to be unambiguous and based on shape (regex on the runid format), so `dither plugin runs $arg` can't accidentally resolve to the wrong thing.
8. As a user reading `dither plugin --help`, I want one runs entry — not separate `list` and `tail` subcommands — so the surface stays small.
9. As a user reading run output, I want "3 added" instead of "3 promoted", so the count matches my mental model of what the plugin just did.
10. As a script author parsing the run's `result.json`, I want a single stable field name (`added`) for the list of paths the run produced, not a name borrowed from the implementation step.

## Implementation Decisions

- **Top-level `runsCommand` deleted.** `main.ts`'s `runs: runsCommand` line goes away. `commands/runs.ts` is deleted; its remaining logic folds into `commands/plugin.ts` (or a small adjacent helper if `plugin.ts` gets too long).
- **New `plugin runs` subcommand** on `pluginCommand`, one positional `<target?>`:
  - missing → list recent runs (replaces old `runs list`)
  - runid-shaped → tail/replay (replaces old `runs tail`)
  - other → resolve as plugin name, tail/replay the newest run
- **RunId shape regex** (used for disambiguation): `^\d{8}T\d{6}-[A-Za-z0-9._-]+-[0-9a-f]{8}$`. This is the format `generateRunId` emits today; plugin names can't satisfy it because the date prefix is rigid.
- **`--limit` flag** on `plugin runs` preserved from old `runs list`, with the same default (20).
- **New `run-log` helper** `findLastRunForPlugin(name): Promise<RunSummary | null>` — walks `listRuns(Infinity)` newest-first and returns the first whose `plugin === name`. Sits next to `listRuns`. Bounded by a generous internal cap (e.g. 500) so we don't scan millions of directories for a never-run plugin name.
- **No deprecation alias.** `dither runs …` simply prints citty's unknown-command error. Acceptable because the project is pre-1.0 and the user prefers deleting code over carrying shims.
- **Help text** on `plugin runs` makes the dual nature explicit: `Inspect plugin runs. With no arg, list recent runs. With a run id, tail/replay it. With a plugin name, tail/replay that plugin's most-recent run.`
- **Error messages**:
  - runid-shaped but no directory → `no run found with id <runid>`
  - plugin name with zero matching runs → `no runs yet for '<name>' — try 'dither plugin run <name>'`
- **No change** to event-streaming internals: `followRun`, `readRun`, result-poll loop, SIGINT handling. The body of the old `tail` action moves verbatim into the new dispatcher branch.
- **Promoted → added rename**, swept in one pass:
  - `run-log.ts`: `EventKind` member `"promoted"` → `"added"`; `RunResultRecord.promoted` → `added`; `RunSummary.promotedCount` → `addedCount`.
  - `plugin-run.ts`: local `promoted` arrays → `added`; the journal `kind: "promoted"` write → `kind: "added"`; `copyPromoted` helper → `copyAdded` (or inline if only one caller after the sweep).
  - `commands/plugin.ts`: `console.log(\`run ${runId} promoted N entries:\`)` → `added N documents:`.
  - `commands/runs.ts` (about to be folded into `plugin.ts`): the `"N promoted"` column in the list output → `"N added"`.
  - `daemon.ts`: `result.promoted` read → `result.added`.
  - Comments and doc strings in `watcher.ts`, `update-index.ts`, `grants.ts`, `collection-registry.ts`, `loop-detector.ts`, `welcome-doc.ts` are updated only where the prose is user-visible (welcome doc) or where a stale name would mislead a future reader; pure internal "promote-time" / "post-promote" notes can stay if reworking them adds noise.
  - **No back-compat shim.** Old `result.json` files keep their `promoted:` key on disk — the reader does not understand it. A user with pre-rename history sees the count as 0 / missing field; they can `rm -rf ~/.dither/history` if they care. Run history is debugging telemetry, not durable state.
- **Tests**: existing `runs.test.ts` moves to `plugin-runs.test.ts` (or merges into `plugin.test.ts`); covers (a) runid path, (b) plugin-name path, (c) no-arg list, (d) plugin-name with zero runs error, (e) runid-shaped but missing error.

## Testing Decisions

- **External behavior only.** Tests drive citty's `runCommand` with the new argv shapes and assert on stdout / exit code. No mocking of `run-log` — they write a real history dir under a temp `DITHER_HOME` and let the production code walk it. Same pattern as the existing `runs.test.ts` (`captureLogs` + `runCommand`).
- **Modules to test**:
  - `findLastRunForPlugin` directly (unit) — empty history, no matching plugin, one match, multiple runs of the same plugin (newest wins).
  - `plugin runs` end-to-end — the five cases above.
- **Prior art**: `commands/runs.test.ts` (the soon-to-be-replaced file) and `commands/plugin.test.ts` already drive citty subcommands with stubbed home dirs; reuse their harness.

## Out of Scope

- Renaming or restructuring run id format. The shape stays exactly as `generateRunId` emits today.
- A `--plugin <name>` filter on the no-arg listing. The bare positional covers the common case; if a power user wants "all runs of bluesky" they can pipe through `grep`.
- Cancelling a running run from the CLI. `dither plugin runs <id>` is still read-only — kill via SIGINT or `dither plugin run --detach`-style controls only.
- Pretty-formatting the tailed events. Output stays raw JSONL so scripts can consume it.
- A back-compat `dither runs` alias. Hard removal.
- Renaming `copyPromoted` and other internal helpers if the surface rename leaves them as the only "promoted" survivor — those are pure implementation detail. The spec calls for them to come along, but if the renamer hits a snag (e.g. test fixture names) they can stay as a tactical follow-up.
- Renaming the "promote" verb in `grants.ts` / collection-registry docstrings where it describes the staging→library copy step accurately. The user-visible noun is what changes; the internal step's name is fine.

## Further Notes

- The `runs.test.ts` file currently tests the `_result` dedup guard (the `emitted` / `inFlight` flags landed earlier this session). That assertion must survive the move — it's the only existing test covering the tail's race-against-`result.json`.
- `printInstallHint` in `plugin.ts` already references `dither plugin run <name>`. No string updates needed there.
- Doc audit: `docs/` may reference `dither runs`. Grep + update before merge.
- `daemon-client.ts` and `commands/init.ts` are unaffected — they consume `followGlobal`, not `followRun`.
