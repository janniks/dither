# Plan: plugin runs subcommand + promoted→added rename

> Source spec: `specs/plugin-runs.md`

## Architectural decisions

- **Command surface**: `dither plugin runs [target?]` replaces top-level `dither runs list|tail`. Single positional, three branches: no-arg → list; runid-shaped → tail; else → resolve as plugin name. Top-level `runs` deleted, no alias.
- **Disambiguation regex**: `^\d{8}T\d{6}-[A-Za-z0-9._-]+-[0-9a-f]{8}$` — matches `generateRunId`'s output, plugin names can't satisfy it.
- **Naming**: every user-visible "promoted" surface → "added". Event kind `promoted` → `added`. Result field `promoted: string[]` → `added`. Summary `promotedCount` → `addedCount`. CLI output `"N promoted"` → `"N added"`.
- **No back-compat shim**: old on-disk `result.json` with `promoted:` keys read as missing-field. Run history is debugging telemetry.

---

## Phase 1: Rename promoted → added

**User stories**: 9, 10

Sweep the rename through run-log, plugin-run, daemon, plugin command, runs command, welcome doc. Tests updated. No behavior change; just identifiers and strings.

**Acceptance:**
- [x] `EventKind` includes `"added"`, not `"promoted"`
- [x] `RunResultRecord` field is `added: string[]`
- [x] `RunSummary` field is `addedCount`
- [x] CLI list output prints `"N added"`
- [x] CLI tail trailer prints `"added N documents:"`
- [x] All tests pass

---

## Phase 2: Move runs under plugin + plugin-name resolver

**User stories**: 1, 2, 3, 4, 5, 6, 7, 8

Add `findLastRunForPlugin(name)` to `run-log.ts`. Add `plugin runs [target?]` subcommand with positional dispatch. Delete `commands/runs.ts` and its registration. Move/extend tests.

**Acceptance:**
- [ ] `dither plugin runs` lists recent runs
- [ ] `dither plugin runs <runid>` tails that run (same behavior as old `runs tail`)
- [ ] `dither plugin runs <name>` resolves to the newest matching run and tails it
- [ ] Plugin name with zero runs prints a friendly error and exits non-zero
- [ ] Runid-shaped but missing prints `no run found with id <runid>` and exits non-zero
- [ ] `dither runs ...` is gone — citty reports unknown command
- [ ] Tests cover all five dispatch paths

---

## Phase log

|  |  |
|--|--|
|  |  |
