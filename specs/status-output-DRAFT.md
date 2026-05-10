---
status: draft
priority: P2
---

# `dither status` — output cleanup (DRAFT)

## Problem

Today's `dither status` output is noisy, doesn't surface a real
configuration problem, and lacks visual hierarchy.

```
config dir:  /Users/jannik/.config/dither
  (env: DITHER_DIR)
library:     /var/folders/xl/wb9.../T/dither-daemon-test-KhMGTb/entries
  (config: library.path — set by `dither init --library`)
plugins:     17
collections: 0
entries:     0
daemon:      not running
```

Concrete issues:

1. **Source-attribution lines bury the actual values.** Every path
   carries a parenthetical second line. Useful once when you're
   learning, noise forever after.
2. **Stale-library invisible.** The path above points at a
   `dither-daemon-test-...` tmpdir that no longer exists. Status
   reports `collections: 0, entries: 0` as if the library were empty —
   actually it's *missing*. `plugins: 17` contradicts that silently.
3. **No visual hierarchy.** Locations, content stats, and runtime
   status all run together without grouping. Hard to skim.
4. **No color.** Boring; misses obvious wins like green for
   "running", yellow for warnings.

## Solution

Three changes plus consistent color.

### 1. Drop the source-attribution lines

Default output is clean. The only place a "where did this come from"
hint appears is **a single header line at the top, only when
`DITHER_DIR` is set in the environment**:

```
DITHER_DIR=/Users/jannik/.config/dither

config dir:  /Users/jannik/.config/dither
library:     /Users/jannik/.dither/library

plugins:     17
collections: 5
entries:     1,247

daemon:      running (pid 4429)
```

If `DITHER_DIR` isn't set (default fallback path or `XDG_CONFIG_HOME`
in use), the header line is omitted entirely. No `(env: ...)` /
`(config: ...)` parentheticals anywhere.

No `--explain` flag. The information is either always shown (the
`DITHER_DIR=` header) or it's not in the output. Keeps the surface
clean.

### 2. Detect stale / missing library

If `library.path` is set in config but the directory doesn't exist or
isn't readable, surface it:

```
library:     /var/folders/.../entries  ⚠ missing — directory does not exist

plugins:     17
collections: —
entries:     —
```

Counts switch from `0` to `—` so it's obvious they're not actually
zero — they're unknowable until the library is restored. Detection
runs by default (not behind a flag): it's a correctness feature, not
a debug feature.

### 3. Group output sections

Visually separate locations, content stats, runtime status with blank
lines:

```
config dir:  /path
library:     /path

plugins:     17
collections: 5
entries:     1,247

daemon:      running (pid 4429)
```

Three sections. Easy to skim.

### 4. Color (per `notes/color-conventions.md`)

Use `colorette` (already in the tree as a `consola` dep). Five
semantic roles:

- `green("running")` for daemon up; `dim("not running")` for daemon down.
- `yellow("⚠ missing — ...")` / `yellow("⚠ unreadable — ...")` for
  library health warnings.
- `dim("—")` for unknowable counts.
- `cyan("DITHER_DIR")` for the env header label.
- `bold` reserved for the header line itself.

Everything else stays default-colored. Plain numbers, plain paths.
`NO_COLOR=1` strips colors; glyphs (`⚠`, `—`) survive.

## Decisions

### `--json` mode

Existing `--json` output extends to carry library health:

```json
{
  "configDir": "/Users/jannik/.config/dither",
  "configDirSource": "env" | "xdg" | "fallback",
  "library": "/path",
  "libraryHealth": "ok" | "missing" | "unreadable" | "unconfigured",
  "plugins": 17,
  "collections": 5 | null,
  "entries": 1247 | null,
  "daemon": { ... }
}
```

`null` for `collections` / `entries` when health isn't `"ok"`. JSON
output never colors (consola/colorette auto-disable on non-TTY pipes;
we'll be explicit too). See `notes/json-output-audit.md` for the
broader cross-command JSON pass.

### Stale-library detection

Check at status time:
- `existsSync(library.path)` — fast, sufficient for the common case.
- If exists, attempt `access(library.path, R_OK)` — surface
  "unreadable" separately from "missing".
- If missing or unreadable, set `libraryHealth` accordingly; switch
  collection / entries counts to `null` (JSON) / `—` (human).

### Number formatting

Comma-thousands separators on `collections` / `entries`.
`Intl.NumberFormat` is built into Node, no dep.

### Long-path handling

Show the full path. No middle-truncation. If a path wraps in a narrow
terminal, that's fine — wrapping shows all of it; truncating loses
information. (User explicitly preferred this.)

### Exit code

Stays zero for missing/unreadable libraries. Status reports; it
doesn't gate. CI gating can come later via a future `dither status
--check` flag if a real use case emerges.

## Behavior matrix

| Scenario | Output |
|---|---|
| Healthy install, `DITHER_DIR` set | header + grouped sections + colors |
| Healthy install, no `DITHER_DIR` (XDG / fallback) | grouped sections, no header |
| Library missing | yellow `⚠ missing` + `—` counts |
| Library unreadable | yellow `⚠ unreadable` + `—` counts |
| Pre-init (no config) | `library: dim("(not configured — run \`dither init\`)")` |
| Daemon running | `green("running (pid N)")` |
| Daemon not running | `dim("not running")` |

## Implementation surface

- `status.ts` — extend `DitherStatus` with `libraryHealth: "ok" |
  "missing" | "unreadable" | "unconfigured"`. Counts become `number |
  null` (`null` when health isn't `"ok"`).
- `commands/status.ts` — new printer: header line if
  `process.env.DITHER_DIR`, three sections separated by blank lines,
  comma-formatted counts, `colorette` colors per the conventions
  note.
- Tests:
  - `status.test.ts` — extend with `libraryHealth` cases (missing,
    unreadable). Counts assert `null` for non-ok states.
  - `commands/status.test.ts` (new) — golden-output style: assert
    key substrings under healthy / missing / no-config and `--json`.

## Out of scope

- New status fields (qmd index size, total disk usage).
- Live-updating dashboard.
- Stale-state auto-repair.
- User-configurable color theming.

## Open questions

- Symlink-aware path display. If user `ln -s ~/dither ~/Documents/dither`
  and inits with the latter, do we display the symlink or the real
  target? Today's init canonicalises to the real target; status shows
  what config.json holds. **Recommend**: leave alone. Consistent.
- Is there a case for showing both `DITHER_DIR=...` and an `XDG_CONFIG_HOME`
  hint when XDG is what the resolver picked? **Recommend**: no. Rule
  is "show env source only when DITHER_DIR is the override." XDG and
  the fallback are silent.
