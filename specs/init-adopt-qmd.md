## Problem Statement

A user with an existing qmd setup runs `dither init` and ends up with a parallel, empty world. Their qmd collections (e.g. `~/Documents/notes/work`, `~/Sync/personal`) are invisible to dither until they manually `dither collection add` each one. Their qmd index DB at `~/.cache/qmd/index.sqlite` is also ignored — dither rebuilds its own. This is friction for the most common adoption path: "I already use qmd, I want to try dither alongside it."

## Solution

`dither init` discovers an existing qmd config and auto-adopts its collections as dither external collections. The user's qmd setup keeps working; dither becomes a second front-end over the same markdown trees. No per-collection commands required.

Index DB reuse is **deferred** (Layer 2 — see Out of Scope).

## User Stories

1. As a qmd user running `dither init` for the first time, I want dither to discover my qmd collections automatically, so that `dither search` works on my existing notes without per-collection setup.
2. As a qmd user, I want to see exactly which collections dither adopted from qmd, so that I can verify nothing was missed or wrongly mapped.
3. As a qmd user, I want collections that already live inside my chosen dither library root to *not* be double-registered as externals, so that the same notes don't appear twice in search.
4. As a qmd user, I want adoption to be a one-time event at init, so that later edits to my qmd config don't silently mutate dither's view.
5. As a qmd user with a project-local qmd setup (`.qmd/index.yaml`), I want dither to find that too when my library root sits under or alongside the project, so I don't have to point at the global config manually.
6. As a non-qmd user running `dither init`, I want zero behavioural change, so that the new code path is invisible to me.
7. As a qmd user with a malformed or unreadable qmd config, I want init to continue normally with a warning, so that a broken qmd YAML doesn't block my dither setup.

## Implementation Decisions

### Discovery sources

Two sources, checked in this order. Both are read-only.

1. **Global qmd config**: `~/.config/qmd/index.yml` (or `index.yaml`). qmd's documented default location.
2. **Local qmd config**: walk upward from `library.path` (the resolved canonical path) looking for `.qmd/index.yaml` or `.qmd/index.yml`. Stops at filesystem root.

If both exist, both are read; collections from the local config take precedence on name collision (closer-to-library wins). The exact precedence is a one-line rule and we document it in the discovery summary.

If neither exists, the new step is a silent no-op — the existing init flow continues unchanged.

### What we read from qmd YAML

Only:
- `collections.<name>.path` — the directory to mount.

We **deliberately ignore**:
- `collections.<name>.pattern` — dither hardcodes `**/*.md`. A non-`.md` glob in qmd is rare and adopting it would expand grant semantics dither doesn't model yet.
- `collections.<name>.ignore` — dither doesn't honour ignore globs at the qmd-index level. Surfacing them as a partial feature would be misleading.
- `collections.<name>.context`, `global_context` — dither has no prompt-context model.
- `collections.<name>.update` — bash hook; dither has plugins for this and we don't want to run arbitrary qmd hooks at init.
- `models` — dither owns its own model choices.
- `includeByDefault` — dither always searches every collection.

Adoption is "name + path only." If a user wants the ignore/context/update semantics, qmd keeps doing that work; dither just gets a second read-only window.

### Mapping qmd collections to dither

For each qmd collection `{name, path}`:

1. **Canonicalise** the path (resolve symlinks, `~` expansion, `realpath`). Skip if the path doesn't exist or isn't a directory; warn-and-continue.
2. **If canonical path is inside `library.path`**: skip. The subdir-as-collection model already covers it. Surface this as "covered by library."
3. **If canonical path equals or contains `library.path`**: skip with a warning. We don't want an external that swallows the library.
4. **If path overlaps an external we already adopted in this pass**: skip with a warning (qmd permits overlapping definitions; dither doesn't).
5. **Sanitise the name**:
   - If name contains `/` (qmd allows; dither doesn't): replace with `-`.
   - If sanitised name is empty: derive from the folder leaf (same as `defaultSlug`).
   - If sanitised name collides with a library subdir (case-insensitive) or a prior-adopted external: suffix `-1`, `-2`, … until unique. Surface the rename.
6. **Append** `{name, path: canonical}` to `cfg.collections.external` in-memory.

After the loop, write `config.json` once with the full external list.

We reuse `addExternal()` from `collection-registry.ts` for the actual append + validation — that already enforces every rule above (overlap, name collision, library overlap). On `RegistryError`, we catch, warn, continue with the next collection. The renaming retry loop is the only new logic in the init module.

### Module boundary

A new module `qmd-import.ts` exposes a single pure function:

```ts
discoverQmdCollections(libraryPath: string, homedirOverride?: string): Promise<QmdImportResult>
```

Return shape:
```ts
type QmdImportResult = {
  source: { path: string; kind: "global" | "local" } | null;
  collections: Array<{ name: string; path: string }>;  // raw, pre-validation
  warnings: string[];  // human-readable, includes parse errors
};
```

`init.ts` calls it after `resolveLibraryPath`, runs the mapping logic against the resolved config, then prints a summary. The mapping logic is a second pure function `applyQmdImport(cfg, result, librarySubdirs)` that returns `{cfg, adopted, skipped}` for testability — same shape pattern as `decideRunOutcome` in `refire.ts`.

### Output during init

After `wrote config.json` and before `indexing library...`:

```
✓ found qmd config at ~/.config/qmd/index.yml
  adopted 3 collections: work, personal, archive
  skipped 1 (notes — inside library)
```

If nothing is found, no line at all (silent). If found but every collection is skipped, one line:

```
! found qmd config at ~/.config/qmd/index.yml — all collections skipped (already covered by library or invalid)
```

Renames surface inline:

```
  adopted 3 collections: work, personal-1 (renamed from personal/inbox), archive
```

### Idempotence / re-init

`init` already bails if `config.json` exists, so adoption happens exactly once. Re-discovery later is a separate command (`dither collection import qmd`), which is **deferred** — not in this spec.

### YAML parsing

qmd's config uses real YAML. We need a YAML parser. Choice: vendor a minimal one or use `yaml` (qmd's choice). Recommend: `yaml` from npm — popular, well-tested, satisfies the 7-day rule trivially. Adding one dep is acceptable for this; the parse surface is small enough that we don't write our own.

If parsing fails, we emit a warning to `result.warnings` and treat the source as empty. Init continues normally.

## Testing Decisions

Two pure functions to cover, no I/O mocking:

1. **`applyQmdImport(cfg, result, librarySubdirs)`** — the mapping/dedup/rename logic. Property-style cases:
   - empty result → cfg unchanged
   - collection inside library.path → skipped with reason "covered"
   - collection overlapping existing external → skipped with reason "overlap"
   - name collision with library subdir → renamed with suffix
   - name with `/` → sanitised
   - same name twice → second gets `-1`
   - canonicalisation: input path is a symlink to a registered external → skipped (same real path)
2. **`discoverQmdCollections`** with a real tmp filesystem (no mocks, per AGENTS.md). Cases:
   - no qmd config anywhere → `source: null, collections: []`
   - global config only → reads it
   - local config only (walks up from library) → reads it
   - both exist → both, with documented precedence
   - malformed YAML → empty + warning, no throw

Init command integration test: spin up a tmp home + tmp library + tmp qmd config, run the command, assert `config.json` has the expected externals and stdout contains the summary line. Pattern matches `init.test.ts`'s existing `captureLogs` approach.

## Out of Scope

- **Layer 2: DB reuse.** Pointing dither at `~/.cache/qmd/index.sqlite` instead of building its own. Risk: shared schema migrations between dither's pinned `@tobilu/qmd` and the user's system qmd. The win (instant search on adoption) doesn't outweigh the cross-tool corruption risk yet. Revisit when qmd's schema stabilises.
- Importing `ignore`, `context`, `global_context`, `update`, `models`, `pattern`. See "What we read."
- Re-discovery / `dither collection import qmd` post-init command.
- Two-way sync (writing dither externals back into qmd's YAML).
- Honouring qmd's `.qmd/` walk-up beyond a single library root (we only walk up from `library.path`, not from the user's `cwd`).

## Further Notes

- The same `qmd-import.ts` module is the natural home for a future `dither collection import qmd` command — we just expose `discoverQmdCollections` + `applyQmdImport` to a new command file. Don't build the command now.
- Library-subdir collections still re-index from scratch into dither's own SQLite. That's expected. Layer 2 is what fixes the re-index cost; this spec doesn't.
- If a user runs qmd's `qmd update` later, dither's index goes stale until next `store.update()`. That's the same staleness story as any external editor — not new behaviour, just newly visible.
