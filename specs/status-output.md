---
status: complete
priority: P2
---

# `dither status` — output cleanup

## Problem Statement

`dither status` is the first thing users type to find out where things
live and whether their install is healthy. Today's output is noisy in
two ways and silent on a real configuration problem.

```
config dir:  /Users/jannik/.config/dither
  (env: DITHER_DIR)
library:     /var/folders/.../T/dither-daemon-test-KhMGTb/entries
  (config: library.path — set by `dither init --library`)
plugins:     17
collections: 0
entries:     0
daemon:      not running
```

Specifically:

1. **Source-attribution lines bury the actual values.** Every path
   carries a parenthetical second line. Useful once when learning,
   noise forever after.
2. **Stale-library invisible.** That tmpdir doesn't exist anymore.
   Status reports `collections: 0, entries: 0` as if the library were
   simply empty — actually it's *missing*, and the counts are
   contradicted by `plugins: 17`.
3. **No visual hierarchy.** Locations, content stats, and runtime all
   run together without grouping.
4. **No color.** Plain text everywhere; common terminal-CLI cues for
   success / warning / muted are unused.

## Solution

Four changes:

1. **Drop the source-attribution lines.** Replace them with a single
   optional header line `DITHER_DIR=/path` printed *only when the
   `DITHER_DIR` env var is set*. If XDG or the fallback won, no
   header. No `--explain` flag — the rule is binary.
2. **Detect missing or unreadable library.** When `library.path` in
   config doesn't exist or isn't readable, surface `⚠ missing` /
   `⚠ unreadable` inline. Switch `collections` and `entries` from `0`
   to `—` (or `null` in JSON) so the meaning is preserved: not
   "empty," but "unknowable until you fix the library."
3. **Group output into three sections** with blank-line separators —
   locations, content stats, runtime status.
4. **Apply color** per `notes/color-conventions.md`. Use `colorette`
   (already in the tree via `consola`). Paint only meaning-bearing
   words; values stay default-colored.

## User Stories

1. As a user running `dither status` daily, I want a clean output
   without "where did this come from" parentheticals on every line,
   so the actual paths are easy to scan.
2. As a user who has explicitly overridden `DITHER_DIR` in their
   shell, I want the very first line to confirm that override, so
   I'm reminded which config dir this command is reading from.
3. As a user on a fresh install with no `DITHER_DIR` set, I want no
   header line, so I'm not confused by env-attribution for a
   default-resolved path.
4. As a user whose library tmpdir was deleted between sessions, I
   want `dither status` to surface that visibly (`⚠ missing`) so I
   know my install is in a broken state, instead of silently
   reporting zero collections and entries.
5. As a user reading `collections: —` and `entries: —`, I want it
   clear those are unknowable values (not zero), so I don't think my
   library was just empty.
6. As a user skimming output from a far-away terminal, I want
   sections separated by blank lines, so I can pick out "where my
   stuff lives" vs "what's in it" vs "is the daemon up" at a glance.
7. As a user, I want the running daemon shown in green and a not-
   running daemon shown dim, so the system state is signaled without
   me reading the word.
8. As a user with `NO_COLOR=1` set, I want the same information
   conveyed with glyphs (`⚠`, `—`) that survive color stripping, so
   the structure is still legible.
9. As an agentic / scripted caller using `dither status --json`, I
   want a `libraryHealth` field and `null` counts when the library
   isn't healthy, so my consumer can branch on the actual condition
   instead of guessing from a `0`.
10. As an agentic caller, I want `--json` output to never contain
    color codes, so my downstream parser doesn't need to strip ANSI.
11. As a user with a long library path, I want it shown in full even
    if it wraps in a narrow terminal, so I never lose information to
    middle-truncation.
12. As a user inspecting status before init, I want the library row
    to read `(not configured — run \`dither init\`)` in dim color, so
    the action I should take is right there.
13. As a maintainer adding a new role to status output later, I want
    color choices to follow the table in `notes/color-conventions.md`,
    so the visual language stays consistent across commands.
14. As a user looking at counts, I want comma-thousands separators on
    `collections` / `entries`, so 12,847 reads cleanly.

## Implementation Decisions

### Status module

`DitherStatus` extends:

- `libraryHealth: "ok" | "missing" | "unreadable" | "unconfigured"`.
- `collections` and `entries` become `number | null` — `null` when
  `libraryHealth !== "ok"`.
- `configDirSource: "env" | "xdg" | "fallback"` — informs the
  optional header line in the human printer and goes into JSON output
  for downstream consumers.

Detection:
- If `loadConfig()` returns null → `libraryHealth = "unconfigured"`.
- Otherwise, `existsSync(library.path)` false → `"missing"`.
- Otherwise, `access(path, R_OK)` throws → `"unreadable"`.
- Otherwise → `"ok"` and the existing markdown-walk runs.

Source detection mirrors the resolver chain in `home.ts`: if
`process.env.DITHER_DIR` is set, source is `"env"`; else if
`process.env.XDG_CONFIG_HOME` is set, `"xdg"`; else `"fallback"`.
(Legacy `DITHER_HOME` falls under `"env"` since it's also explicit.)

### Status command (human output)

The printer:

1. If `configDirSource === "env"`, emit a header line:
   `bold(cyan("DITHER_DIR")) + "=" + configDir` followed by a blank line.
2. Locations section:
   - `config dir:  ` + `configDir`.
   - `library:     ` + value, with health-aware suffix:
     - `"ok"` → just the path.
     - `"missing"` → path + `  ` + `yellow("⚠ missing — directory does not exist")`.
     - `"unreadable"` → path + `  ` + `yellow("⚠ unreadable — directory exists but is not readable")`.
     - `"unconfigured"` → `dim("(not configured — run `dither init`)")`.
3. Blank line.
4. Content section:
   - `plugins:     ` + plugin count.
   - `collections: ` + count or `dim("—")`.
   - `entries:     ` + count or `dim("—")`.
   When health isn't `"ok"`, append `dim("(library missing)")` /
   `dim("(library unreadable)")` to `entries`.
5. Blank line.
6. Runtime section:
   - `daemon:      ` + `green("running (pid N)")` or `dim("not running")`.
   - When running and snapshot present: `  running plugins: N` (plain).

Counts always get comma-thousands separators via `Intl.NumberFormat`.

Long paths are shown in full with no truncation. If they wrap in a
narrow terminal, that's acceptable.

No `--explain` flag.

### Status command (JSON output)

JSON shape:

```json
{
  "configDir": "/path",
  "configDirSource": "env" | "xdg" | "fallback",
  "library": "/path" | null,
  "libraryHealth": "ok" | "missing" | "unreadable" | "unconfigured",
  "plugins": 17,
  "collections": 1247 | null,
  "entries": 12847 | null,
  "daemon": { "running": true, "pid": 4429, ... },
  "home": "/path"
}
```

`home` retained as deprecated alias of `configDir` (Phase 2 of the
init-interactive feature already locked this in for one release).

JSON output is always plain — no color codes. `colorette` auto-
disables on non-TTY pipes; we don't need explicit stripping but tests
will assert no ANSI in JSON output anyway.

### Color and glyphs

Per `notes/color-conventions.md`. Roles used here:

- `green("running (pid N)")` for daemon up.
- `yellow("⚠ missing — ...")` / `yellow("⚠ unreadable — ...")` for
  library health warnings.
- `dim("—")` for unknowable counts; `dim("(library missing)")` for
  the trailing context; `dim("not running")` for daemon down;
  `dim("(not configured — run \`dither init\`)")` for unconfigured.
- `bold(cyan("DITHER_DIR"))` for the env header label.

Don't paint plain values (paths, counts when known). `NO_COLOR=1`
strips colors; glyphs survive.

### Number formatting

`new Intl.NumberFormat(undefined).format(n)` — locale-aware commas.
Built into Node, no dep. Applied to `plugins`, `collections`,
`entries` in human mode only; JSON keeps raw numbers.

### Exit code

Stays zero regardless of library health. Status reports; it doesn't
gate. CI gating can come later via a future `dither status --check`
flag if a real use case emerges.

## Testing Decisions

- **Test external behavior, not internals.** Drive through `getStatus()`
  and the command's `run()` with various fixtures; assert on the
  returned struct + the captured stdout / stderr.
- **`status.test.ts`** — extend with cases for each `libraryHealth`
  value: ok, missing, unreadable, unconfigured. Assert counts are
  numeric in `ok` and `null` otherwise.
- **`commands/status.test.ts`** (new) — golden-substring style:
  - Healthy install with `DITHER_DIR` set → output contains the
    header line + the expected three section markers + comma-formatted
    counts.
  - Healthy install without `DITHER_DIR` → no header line.
  - Library missing → output contains `⚠ missing` and `—`.
  - Pre-init → output contains `(not configured — run \`dither init\`)`.
  - `--json` → output is one JSON value, parses cleanly, contains
    `libraryHealth` and `configDirSource`, contains no ANSI escape
    sequences.
- **No mocks for `colorette`.** Tests run in the non-TTY vitest
  environment where colorette auto-disables; assertions are on plain
  text. A focused test or two enables `FORCE_COLOR=1` to verify
  glyphs survive even when colors are stripped (`NO_COLOR=1`).

## Out of Scope

- New status fields (qmd index size, total disk usage, last-run-at).
- Live-updating dashboard / TUI.
- Stale-state auto-repair. Status reports; user fixes.
- User-configurable color theming.
- A `--check` flag with non-zero exit on issues. Defer until a CI use
  case shows up.
- Symlink-resolved path display when `library.path` is a symlink.
  Init canonicalises at write time; status shows what config holds.
  Consistent — leave alone.

## Further Notes

- The single-optional-header design was a deliberate trim from an
  earlier `--explain` flag proposal. Flag-gated complexity for what
  amounts to one line of output didn't earn its keep.
- The `configDirSource` field in JSON is informational — agentic
  consumers don't typically branch on it, but they get it for free
  and it costs us nothing.
- This spec touches the same files as the init-interactive spec's
  Phase 2 (status split). Implementation extends that work; doesn't
  conflict with it.
- See `notes/color-conventions.md` and `notes/json-output-audit.md`
  for the broader CLI-wide conventions this status spec is the first
  user of.
