# Plan: `dither status` output cleanup

> Source spec: `specs/status-output.md`

## Architectural decisions

- **`DitherStatus`** extends with: `libraryHealth: "ok" | "missing" |
  "unreadable" | "unconfigured"`, `configDirSource: "env" | "xdg" |
  "fallback"`. `collections` and `entries` become `number | null`.
- **Library health detection**: `existsSync(library.path)` → `access(R_OK)` →
  walk. Any failure short-circuits to a non-`ok` health and `null` counts.
- **Source detection** mirrors `home.ts`'s resolver chain: `DITHER_DIR` →
  `env`, `XDG_CONFIG_HOME` set → `xdg`, else `fallback`. Legacy
  `DITHER_HOME` falls under `env`.
- **Color**: `colorette` (already in tree via `consola`). Per
  `notes/color-conventions.md`. NO_COLOR-respecting; glyphs survive.
- **Header line**: only when `configDirSource === "env"`. No flag.
- **Number formatting**: `Intl.NumberFormat` for human mode only.
  JSON keeps raw numbers.
- **Exit code**: stays zero on all health states.

---

## Phase 1: Library health + status struct extension

Detect missing/unreadable library at status time. Extend `DitherStatus`
with `libraryHealth` and `configDirSource`. Counts go `number | null`.
JSON consumers see the new shape immediately. Human printer not yet
updated — it still prints the old format minus the source-attribution
parentheticals (those go away cleanly in this phase since
`configDirSource` is now a structured field instead of a hardcoded
string).

**User stories**: 4, 5, 9.

**Acceptance:**
- [x] `getStatus()` returns `libraryHealth: "ok"` for a healthy install
      with markdown-walk counts as before.
- [x] When `library.path` doesn't exist on disk, `libraryHealth ===
      "missing"` and `collections` / `entries` are `null`.
- [x] When `library.path` exists but is unreadable, `libraryHealth ===
      "unreadable"` and counts are `null`.
- [x] When no config exists, `libraryHealth === "unconfigured"`,
      `library === null`, counts are `null`.
- [x] `configDirSource` returns `"env"` when `DITHER_DIR` (or legacy
      `DITHER_HOME`) is set; `"xdg"` when `XDG_CONFIG_HOME` is the
      effective source; `"fallback"` otherwise.
- [x] `--json` output exposes `libraryHealth` and `configDirSource`.
- [x] `home` field retained in JSON as deprecated alias.
- [x] Existing `status.test.ts` cases continue passing; new cases
      cover each `libraryHealth` value.

**Outcome:** `DitherStatus` extended with `libraryHealth` and
`configDirSource`. `collections`/`entries` are `number | null`.
`status.test.ts` grew from 5 → 11 cases. `lifecycle.test.ts`'s
`beforeEach` now `mkdir`s the library before writing config so the
existing "fresh home" test gets a healthy empty library (rather than
the new "missing" health). Pre-existing deno-bootstrap-download
timeouts in lifecycle's other tests are unrelated.

---

## Phase 2: Human printer — header, sections, ⚠ glyph, `—` placeholder

Rewrite `commands/status.ts` to print:
- An optional header `DITHER_DIR=/path` (only when source is `"env"`),
  followed by a blank line.
- A locations section (config dir + library, with health-aware
  suffix).
- A blank line.
- A content section (plugins, collections, entries — with `—` glyph
  when health isn't `ok`, plus a trailing context note for
  `entries`).
- A blank line.
- A runtime section (daemon).

No source-attribution parentheticals anywhere. Comma-thousands on
counts. No color yet — that comes in Phase 3.

**User stories**: 1, 2, 3, 4, 5, 6, 11, 12, 14.

**Acceptance:**
- [x] With `DITHER_DIR` set, output begins with `DITHER_DIR=/path`
      followed by a blank line.
- [x] Without `DITHER_DIR` set, the header line is absent.
- [x] No `(env: ...)` or `(config: ...)` parentheticals appear.
- [x] Three sections separated by blank lines: locations, content,
      runtime.
- [x] Library missing → output contains `⚠ missing — directory does
      not exist` next to the path.
- [x] Library unreadable → contains `⚠ unreadable — ...`.
- [x] Counts when not `ok` show `—` (em dash, not hyphen-minus).
- [x] Pre-init → `library: (not configured — run \`dither init\`)`.
- [x] Counts use comma-thousands separators (e.g. `1,234`).
- [x] Long paths render in full (no truncation).

**Outcome:** New `printHumanStatus` in commands/status.ts. Optional
header gates on `configDirSource === "env"`. Three blank-line-
separated sections. Library row gets a health-aware suffix (`⚠
missing`/`⚠ unreadable`) or a pre-init placeholder. Counts switch
between `Intl.NumberFormat`-formatted numbers and the em-dash glyph.
New commands/status.test.ts adds 9 cases covering header on/off, no
attribution noise, missing/unreadable/unconfigured states, comma
formatting, and JSON shape (libraryHealth + configDirSource present;
no ANSI). 21 tests green combined with status.test.ts. Live smoke
of the original scenario (deleted tmpdir library) shows ⚠ missing +
— instead of silent zeros.

---

## Phase 3: Color via `colorette`, NO_COLOR-respecting

Apply the color conventions:
- `bold(cyan("DITHER_DIR"))` on the header label.
- `green("running (pid N)")` / `dim("not running")`.
- `yellow("⚠ missing — ...")` / `yellow("⚠ unreadable — ...")`.
- `dim("—")` and `dim("(library missing)")` / `dim("(library
  unreadable)")` / `dim("(not configured — ...")`.

Plain values (paths, known counts) stay default-colored. JSON output
never colors. `NO_COLOR=1` strips colors; glyphs survive.

**User stories**: 7, 8, 10, 13.

**Acceptance:**
- [ ] Daemon-running label is green (visible under `FORCE_COLOR=1` in
      tests).
- [ ] Daemon-not-running label is dim.
- [ ] Library health warnings are yellow.
- [ ] Counts show as `dim("—")` when health isn't `ok`.
- [ ] `NO_COLOR=1` strips ANSI escapes; the `⚠` and `—` glyphs
      remain in output.
- [ ] `--json` output contains no ANSI escape sequences regardless
      of color env vars.
- [ ] Plain values (paths, integer counts when `ok`) are not painted.

---

## Phase log

When starting, rename to `./plans/status-output-RUNNING.md`. Tick
acceptance per phase, commit, append a row, rename back when complete.

| commit | summary |
|--------|---------|
| f226cae | Phase 1: DitherStatus + libraryHealth + configDirSource. status.test.ts 5→11 cases; lifecycle.test.ts mkdir before writeConfig. |
| (pending) | Phase 2: human printer rewrite — DITHER_DIR header, three sections, ⚠/— glyphs, comma counts. New commands/status.test.ts (9 cases). 21 tests green. |
