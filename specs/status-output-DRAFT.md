---
status: draft
priority: P2
---

# `dither status` — output cleanup (DRAFT)

## Problem

Today's `dither status` output is noisy in two ways and silent on a real
problem.

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

1. **Source-attribution lines bury the actual values.** Every path now
   carries a parenthetical `(env: ...)` / `(config: ... — set by ...)`
   on its own line. Useful once when you're learning the system, noise
   forever after.
2. **Stale-library invisible.** The path above points at a `dither-daemon-test-...`
   tmpdir that no longer exists. Status reports `collections: 0,
   entries: 0` as if the library is empty — actually it's *missing*.
   No glyph, no warning, no hint at the contradiction with `plugins: 17`.
3. **No visual hierarchy.** Locations, content stats, and runtime
   status all run together without grouping. Hard to skim.
4. **Long paths wrap awkwardly.** The `library:` value can be longer
   than the terminal width; today's printer lets it wrap mid-path.

## Solution

Three changes, each independently useful:

### 1. Default output is clean — source labels move behind `--explain`

Default columns and values only:

```
config dir:  /Users/jannik/.config/dither
library:     /var/folders/xl/wb9.../T/dither-daemon-test-KhMGTb/entries
plugins:     17
collections: 0
entries:     0
daemon:      not running
```

`dither status --explain` (or `-e`) restores the source labels:

```
config dir:  /Users/jannik/.config/dither   [env: DITHER_DIR]
library:     /var/folders/xl/wb9.../T/...   [config: library.path]
plugins:     17                             [<DITHER_DIR>/plugins/]
collections: 0
entries:     0                              [in library.path]
daemon:      not running
```

Labels become inline trailers, not their own lines.

### 2. Detect stale / missing library

If `library.path` is set in config but the directory doesn't exist or
isn't readable, surface it loudly:

```
library:     /var/folders/.../entries  ⚠ missing — directory does not exist
plugins:     17
collections: —    (library missing)
entries:     —    (library missing)
```

If the library exists but is unreadable, similar treatment with a
different message. Counts switch from `0` to `—` so it's obvious
they're not actually zero — they're unknowable until the library is
restored.

### 3. Group output sections

Visually separate locations, content stats, and runtime status:

```
config dir:  /Users/jannik/.config/dither
library:     /Users/jannik/.dither/library

plugins:     17
collections: 5
entries:     1,247

daemon:      running (pid 4429)
  running plugins: 0
```

Two blank lines = three sections. Easy to skim. Total height grows by
two lines; worth it.

## Decisions

### Default vs `--explain`

Default = clean. `--explain` adds:
- Source attribution for `config dir` and `library`.
- "Where the count came from" trailers (e.g. `[in library.path]` for
  `entries`, `[<DITHER_DIR>/plugins/]` for plugins).
- (Future) the `qmd-index.sqlite` path, the global env file path, the
  daemon log path.

`--json` mode unchanged in shape (already structured); under
`--explain` it adds a `sources` field naming each value's origin.

### Stale-library detection

Check at status time:
- `existsSync(library.path)` — fast, sufficient for the common case.
- If exists, attempt `access(library.path, R_OK)` — surface
  "unreadable" separately from "missing".
- If missing or unreadable, emit `⚠` glyph + reason inline; switch
  collection / entries counts from `0` to `—` so the meaning is
  preserved.

Library-missing detection runs without `--explain`. It's not a debug
feature; it's a correctness feature.

### Number formatting

Comma-thousands separators on `collections` / `entries` for libraries
of any non-trivial size. `Intl.NumberFormat` is built into Node.

### Long-path handling

If `library.path` exceeds terminal width minus the column gutter,
truncate the *middle* with a `…` and right-align so the leaf segment
stays visible:

```
library:     /var/folders/xl/wb9pg…/T/dither-daemon-test-KhMGTb/entries
```

Truncation only kicks in when the line would otherwise wrap. `--json`
output is never truncated.

### Color (via consola)

- `⚠` glyph + warning color for missing/unreadable library.
- `daemon: running` in green; `not running` in dim/grey.
- Counts in default color; `—` placeholders dimmed.

Respects `NO_COLOR` env var (consola already does).

## Behavior matrix

| Scenario | Default | `--explain` |
|---|---|---|
| Healthy install | values + grouped sections | + inline source trailers |
| Library missing | `⚠ missing` + `—` counts | + source trailers |
| Library unreadable | `⚠ unreadable` + `—` counts | + source trailers |
| No config (pre-init) | `library: (not configured — run \`dither init\`)` | same + DITHER_DIR source |
| Daemon running | `running (pid N)` (green) | same |
| Daemon not running | `not running` (dim) | same |

## Implementation surface

- `status.ts` — extend `DitherStatus` to carry library health
  (`"ok" | "missing" | "unreadable" | "unconfigured"`). Counts stay
  numeric for `ok`; for other states they're explicitly
  `null` (unknowable).
- `commands/status.ts` — new printer with column alignment, comma
  formatting, glyphs, color via consola, optional `--explain` trailers,
  and middle-truncation for long paths.
- New `--explain` flag.
- Tests:
  - `status.test.ts` — extend with library-missing and library-
    unreadable cases (assert health field + `null` counts).
  - `commands/status.test.ts` (new) — golden-output style: assert key
    substrings under default, `--explain`, and `--json` modes.

## Out of scope

- New status fields (qmd index size, total disk usage, etc.).
- Live-updating dashboard (that's `ink`-territory; out of scope).
- Stale-state auto-repair. Status reports; user fixes.
- Color theming.

## Open questions

- Does `--explain` apply to `--json` too, or only the human-readable
  printer? **Default**: yes, both. Adding a `sources` map to JSON is
  cheap and consistent.
- Symlink-aware path display? If the user `ln -s ~/dither ~/Documents/dither`
  and inits with the latter, do we display the symlink or the real
  target? Today's init canonicalises to the real target; status shows
  what config.json holds. Consistent — leave alone.
- Should `dither status` exit non-zero when the library is missing?
  Argues for treating status as a health check usable in CI.
  **Recommend**: stay zero-exit for now; add `--check` flag later if
  CI usage emerges. Status's job is to report, not to gate.
