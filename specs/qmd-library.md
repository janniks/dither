## Problem Statement

Today dither hardcodes the markdown library at `~/.dither/entries/` and the qmd index at `~/.dither/qmd-index.sqlite`. Two consequences:

1. **A user who already runs qmd over `~/notes/`** has to either move their files into `~/.dither/entries/` or maintain a parallel index over the same content. There's no way to point dither at an existing markdown library — a hard onboarding stop for the audience most likely to want dither.
2. **dither's metadata** (plugins, grants, runs, journal, locks, daemon pid, status snapshot, env, future keys) is intertwined with the user's actual content. The conceptual split between "your stuff" and "dither's bookkeeping" is invisible — and once it matters (backups, multiple machines), it'll matter sharply.

A secondary issue surfaced while diagnosing this: the indexer does a full collection re-scan on every promote. When the daemon runs many plugins back-to-back, this is wasteful — we already know which collections just received files.

## Solution

Split dither into two roots:

- **dither home** — dither's bookkeeping. Plugins, grants, runs, locks, logs, pid, status, env, config, future keys. Owned by dither.
- **library** — the markdown content. User-chosen at init time; defaults to `<dither-home>/library` for fresh users.

A new `dither init` command is the **required** first step. It writes `<dither-home>/config.json` with the chosen library path; library-needing commands refuse until it has run. After init, every library lookup in the codebase goes through config — no path resolves from a hardcoded `<dither-home>/entries/`.

Dither always owns its own qmd index at `<dither-home>/qmd-index.sqlite`, regardless of where the library lives. Adopting an existing qmd-CLI index (so two tools share one index file) was sketched and deferred — see `notes/qmd-index-reuse.md`. That keeps the v1 contract simple: one library, one dither-owned index, no version-skew or collection-registration handshake with another tool.

Two smaller improvements ride along:

- After a successful promote, the indexer is called with the set of *touched collections* instead of "rescan everything." qmd's SDK exposes `update({ collections })`; we use it.
- The `notes/init-command.md` checklist (pre-download embedding/rerank weights so first `dither search` doesn't hang) is folded into `dither init`.

No migration code. We're pre-users; anyone with a partial install on an early build runs `dither init --library …` themselves (or moves their content).

## User Stories

1. As a qmd user with an existing markdown library, I want to point dither at any folder I choose, so that I'm not forced to use `~/.dither/entries/`.
2. As a new dither user with no prior qmd setup, I want `dither init` to produce a working library inside dither home, so that I can install my first plugin immediately afterward.
3. As any user, I want dither's metadata (plugins, grants, runs) to live separately from my markdown library, so that backing up or moving my markdown doesn't drag dither's internal state with it.
4. As a user, I want `dither init` to pre-download qmd's model weights, so that my first `dither search` doesn't hang on a surprise multi-hundred-MB download.
5. As a user, I want `dither init` to be idempotent — re-running it on an already-initialized home prints the current config and exits cleanly, doesn't destroy state.
6. As a user, I want clear errors when I run library-needing commands before `dither init`, so that I'm never confused about why nothing works.
7. As a user, I want to swap the configured library later, so that dither doesn't lock me into the original choice.
8. As an operator running the daemon, I want plugin promotes to incrementally update the qmd index, so that scheduled-heavy workloads don't do a full rescan on every minute-tick.
9. As a future-me planning multiple libraries, I want the config schema to be additive, so that adding a second library later isn't a breaking change.
10. As a user who runs qmd-CLI over my own notes folder, I want dither to coexist without trampling my qmd state, so that nothing dither does affects what qmd-CLI does (the price for v1: a separate, dither-owned index over the same files).

## Implementation Decisions

### Config

- File: `<dither-home>/config.json`. JSON, written as plain JSON (parsed permissively so JSONC-style comments survive a hand-edit, but we never write comments ourselves).
- Two-level shape only: top-level *section*, one level of keys. Git-config-shaped.
- Schema:

  ```json
  {
    "schema":  { "version": 1 },
    "library": { "path": "/Users/.../dither" }
  }
  ```

  Section names: `schema`, `library`. The `library` section uses the singular name with one `path` key — chosen so a future `libraries` (plural, list) addition is a clean break, not a confusing rename.
- Library path is canonicalised at init via `realpath`. Symlinked paths pin to their resolved target — same rationale as install-time file grants (no silent grant-widening if the symlink target later changes).
- Index path is implicit: always `<dither-home>/qmd-index.sqlite`. Not in config in v1. The deferred index-reuse spec may add `library.db_path` later.
- Lookup precedence for dither home: `DITHER_HOME` env var → `~/.dither/`. Config inside that home is loaded once per CLI invocation; once at daemon startup; re-read on SIGHUP.

### `dither init`

1. Ensure `<dither-home>/` exists.
2. If `config.json` already exists: print the current config and exit 0. `--force` overwrites.
3. Resolve library path: `--library <path>` if given, else `<dither-home>/library`.
4. Validate / create the library directory:
   - Doesn't exist → create with parents. Print what was created.
   - Exists, is a file → error.
   - Exists, not writable → error.
   - Canonicalise via `realpath`.
5. Register each existing top-level subdir of the library as its own qmd collection. Empty library → no collections registered yet (lazily registered on first plugin promote).
6. Write `config.json`.
7. Pre-download qmd model weights. Failure is non-fatal but flagged at the end — search falls back to lex-only until weights land. `--no-download` skips this step.
8. Run `store.update()` once so the qmd SQLite file exists with schema applied.

Flags: `--library <path>`, `--force`, `--no-download`.

### Pre-init guardrails

Library-needing commands (`search`, `get`, `list entries`, `index update`, `plugin install`, `plugin run`, `daemon start`) check for `<dither-home>/config.json` and refuse with:

```
error: dither is not initialized. Run `dither init` to set up your library.
```

Exit code non-zero. No silent fallback to a default. Commands that don't need the library (`--help`, `--version`, `daemon status` showing "no config", `init` itself) keep working.

### Reconfiguration

Library path changes go through `dither init --force --library <new>`. No separate `dither config set` command in v1 — init is the one place config is written. (When config keys multiply, a generic `config set` becomes worth introducing; premature now.)

Re-init does **not** move existing files. The new library path takes effect; the old library is left on disk for the user to handle.

On `--force`, the qmd index is rebuilt: dbPath stays the same (`<dither-home>/qmd-index.sqlite`), old collections registered against the previous library are dropped, new ones registered against the new library's subdirs, full `store.update()` runs once.

### Indexer behavior

- Reads and writes go through the bundled `@tobilu/qmd` SDK. No subprocess calls to qmd-CLI.
- Dither always owns its index at `<dither-home>/qmd-index.sqlite`.
- Mirror approach for collection registration: each top-level subdir of the library is its own qmd collection. Plugins promoting into a new subdir register that collection on first promote.
- After a successful promote, the indexer is called with the *touched-collection set* — `store.update({ collections })`. Cuts work proportional to (collections-touched / collections-total).
- Manual `dither index update` continues to do a full rescan.
- No path-level scoping (would require upstream qmd SDK changes).

### Module shape

- **`config` module (new).** Loads / writes `<dither-home>/config.json`. One narrow surface: `loadConfig()` (returns parsed config or `null` if missing), `saveConfig(cfg)`, `assertInitialized()` (throws the standard pre-init error if no config). Schema validation lives here. Cached in-memory after first load per process.
- **`paths` module (refactor of `home.ts`).** Splits today's mixed bag into two clearly-typed surfaces:
  - *Dither-home paths* — pid, daemon log, status snapshot, locks, logs, plugins, grants, runs, env, config, qmd index dbPath. No config dependency.
  - *Library paths* — `libraryRoot()`, `collectionDir(name)`, plus a helper for "list current top-level subdirs as collections." Takes the loaded config.
  - The two surfaces never mix in one function. Callers either need a dither-home path (resolver doesn't take config) or a library path (does).
- **`init` command module (new).** Orchestrates the init flow. Composed of small steps (validate-or-create-library, write-config, register-collections, prefetch-weights, initial-index). Each step is independently callable for tests.
- **`update-index` (modified).** Gains an optional `collections?: string[]` argument; default behavior (no arg) is unchanged. Callers in `plugin-run.ts` pass the touched-collection set.
- **`store.ts` (modified).** Reads library root + collection list from config, no longer scans `<dither-home>/entries/` directly.
- **`plugin-run.ts` (modified).** Promote target uses library config. Lazy collection registration on first-time promote into a new subdir.
- **`watcher.ts` (modified).** Watch root uses library config.
- **`commands/index.ts` (modified).** `dither index update` reads library from config (refuses with the standard error if missing).

The `config` module is the deep one — narrow interface, lots of behavior (schema validation, JSONC-tolerant parsing, caching, atomic write) hidden behind it. `paths` is also deep in the Ousterhout sense: a few functions, all callsites in the codebase route through them, the typing forces the dither-home / library distinction.

### Notes superseded

`notes/init-command.md` — folded into this spec (model pre-download in step 7 of init). Delete on implementation.

## Testing Decisions

What makes a good test here: drive the public surface (`dither init`, `dither search`, `dither plugin run`) against a tmp `DITHER_HOME` and assert the files / config / index land where they should. Don't test private helpers; don't assert on log messages.

- **`config` module**: round-trip load/save, missing-file → `null`, malformed JSON → typed error, schema-version mismatch behavior, canonicalisation of library path, JSONC-with-comments parses cleanly.
- **`dither init`**: fresh init with default library, fresh init with `--library <new dir>`, fresh init with `--library <pre-existing populated dir>`, idempotent re-run prints + exits 0, `--force` overwrites cleanly, library path is a file → error, library path not writable → error, `--no-download` skips weight prefetch.
- **Pre-init guardrails**: `dither search`, `dither plugin install`, `dither plugin run`, `dither daemon start` against an uninitialized `DITHER_HOME` all exit non-zero with a message pointing at `init`. Smoke test, one assertion each.
- **End-to-end pipeline**: re-point `pipeline.test.ts` and `update-index.test.ts` at a library path *outside* dither home; verify promote → updateIndex → search still works.
- **Incremental update**: promote into one collection, verify `store.update({ collections: [<that one>] })` was the call shape (or assert "indexed count" reflects scope, depending on what the SDK exposes cleanly). If the assertion is brittle against qmd internals, settle for "no full rescan happened" via timing or counter heuristics.
- **Reconfiguration**: `init --force --library <new>` rebuilds the index from the new library; old collections aren't found in the index afterward.

Prior art: `update-index.test.ts`, `pipeline.test.ts`, `cli-dispatch.test.ts` already exercise the promote → index → search loop with a real qmd store and serve as templates.

## Out of Scope

- **Index reuse / adopt-mode.** Sharing a qmd dbPath with qmd-CLI's existing index, with associated CLI detection, search filtering, version-skew tracking. Deferred — see `notes/qmd-index-reuse.md`.
- **Multiple libraries** at runtime. Schema is shaped to admit a future `libraries[]` table cleanly, but v1 has exactly one library.
- **`dither config set` command.** Reconfig goes through `init --force` for v1.
- **`dither qmd:<command>` passthrough.** Promised in `architecture.md`, parked separately.
- **Hot-reload of library path on SIGHUP.** Daemon reads config at startup; library path changes require daemon restart.
- **Migration code for existing `<dither-home>/entries/`.** No users yet; users handle their own moves.
- **Cross-machine config sync.** Each machine has its own `config.json`.
- **Atomic move of library content** when `init --force --library <new>` is run. Old content is left where it is; the user decides what to do with it.

## Further Notes

- **Why JSON, not TOML.** User preference, plus consistency with the rest of dither's on-disk state (`grants/*.json`, `status.json`, `env.json`). JSONC parse-tolerance covers the hand-edit comment use case without forking the file format.
- **Why two-level (section / key) shape.** Mirrors git config and similar tools — discoverable, predictable, and the structure stays flat enough to inspect without a parser.
- **Why dither always owns the index, even for external libraries.** Avoiding the entire complexity tree under `notes/qmd-index-reuse.md`. The cost (duplicate index when a user runs qmd-CLI in parallel over the same library) is real but bounded; the benefit (predictable ownership, no version-skew bugs, no collection-registration handshake) is high.
- **Default library inside dither home is acceptable but not encouraged.** The recommended user pattern is a dedicated folder like `~/Documents/dither` — clearly demarcated, easy to back up, easy to hand to an agent.
- **qmd-CLI passthrough is a separate problem.** Even with this spec, a user who wants to run `qmd query` against the dither library can: dither's index path and library path are stable and printed by `dither init`. Wiring `dither qmd:<command>` is parked separately and doesn't block this work.
