# spec: cli table output

## problem

Several `d` commands print tabular rows using ad-hoc `padEnd` / `padStart`
with fixed widths:

- `d plugin runs` — `padEnd(7)` status, `padEnd(20)` plugin, free-form
  startedAt and duration. Run IDs vary in length (suffix hash size differs),
  so the **first column itself is variable-width** and every column after it
  slides. Looks ragged.
- `d collection list` — `padEnd(20)` for name. Plugins with longer names
  spill past the column.
- `d daemon status` — `startedAt:` / `lastTick:` indented by hand.
- `d search` (TTY branch) — already computes max widths per column and
  pads dynamically. This is the pattern that works.

Effect: rows wobble when content widths shift across runs, columns wrap
unpredictably when the terminal is narrower than the row, and ANSI color
+ `.length` interact badly (color escapes count toward `padEnd` width if
applied before padding).

## stories

- As a user I run `d plugin runs` and the columns line up regardless of
  whether run IDs end in `-35ed` or `-ccb50211`.
- As a user I pipe `d plugin runs | grep ok` and get clean
  tab-separated output that downstream tools can parse.
- As a user I narrow my terminal and the rightmost column truncates
  cleanly instead of wrapping into a second row.
- As an agent I want one helper to call across `plugin runs`,
  `collection list`, `daemon status`, future `plugin list`, etc., so
  cross-command formatting stays consistent.

## options surveyed

| lib | LOC weight | bundle | notes |
|---|---|---|---|
| `cli-table3` | heavy | ~70kb | ascii box borders, ESLint-style; visually too loud for our CLI |
| `table` (latticejs) | heavy | ~250kb | very flexible, total overkill |
| `columnify` | tiny | ~30kb | column-widest layout, no borders, no ansi-width handling out of the box |
| `string-width` + `wrap-ansi` | building blocks | ~15kb total | what we'd need if we DIY ansi-aware widths |
| **in-house helper** | ~40 LOC | 0 | extracted from `search.ts`; mirrors how that command already lays out rows |

## decisions

- **DIY, no new dep.** Mirror `search.ts`'s pattern in a single helper
  `printTable(rows, cols?, opts?)`. Three commands today; if a fourth
  needs something fancier we revisit. Reasons: keeps install size flat,
  no `min-release-age` waits, and `search.ts` already proved the
  approach works.
- **Helper lives in `packages/cli/src/table.ts`** as a self-contained,
  deep-importable module. `prompt.ts` re-exports it so callers can keep
  using `prompt.ts` as the single TUI surface — the file's existing
  docstring ("Single import point for interactive TUI in the CLI")
  extends naturally to include tabular output. Deep-module shape:
  small interface (`printTable` + `ColOpt`), broad capability
  (alignment, color, truncation, TTY/TSV switch) hidden behind it.
  Commands import from `./prompt`; tests import directly from
  `./table` to keep the unit under test isolated.
- **Input shape: `string[][]`.** Color is applied by the helper through
  an optional per-column callback (`color?: (s: string) => string`).
  Caller passes raw text; padding happens before coloring so widths are
  correct.
- **Per-column options:**
  - `align: "left" | "right"` (default left; right for numerics)
  - `max?: number` — truncate with `…` if cell exceeds; clamps column
  - `min?: number` — minimum width (useful when first row is the widest)
  - `color?: (s: string) => string`
- **Gap is two spaces** by default (matches existing aesthetic).
- **Terminal width awareness.** Helper reads `process.stdout.columns`.
  Last column gets the remaining width and middle-truncates with `…`
  so a narrow terminal never wraps. The middle-truncate is inlined in
  `table.ts` rather than imported from `prompt.ts`'s `fitOneLine`, so
  `table.ts` has no dependency on `prompt.ts` (deep-import friendly).
  If no TTY, no truncation — pipes deserve full data.
- **Non-TTY mode: TSV.** When `!process.stdout.isTTY` the helper emits
  raw values joined by `\t`, one row per line, no color, no padding,
  no truncation. Matches `d search` piped behavior. Same call site, two
  outputs.
- **No headers row.** Scrollback density wins over labelling; the
  rightmost column (path / message) already implies what the prior
  columns are. No `header?: string[]` option on the helper.
- **Times.** Add `formatRelPast(ms)` to `relative-time.ts`. Granularity
  is **single-unit** except under 5 minutes, where the two largest
  non-zero units are shown:
  - `<1s` → `now`
  - `<60s` → `Ns ago`
  - `<5m` → `Nm Ns ago` (drop `Ns` when zero)
  - `<1h` → `Nm ago`
  - `<1d` → `Nh ago`
  - `>=1d` → `Nd ago`
  Default time column is the relative form; `-v` adds the exact ISO.
  Applies to `plugin runs` first; other commands as they migrate.

## migration order

1. Land helper + `formatRelPast`.
2. `d plugin runs` — first user of the helper; this is what surfaced
   the bug. Reltime by default, exact under `-v`.
3. `d collection list` — straight port; column widths already computed
   by the helper instead of `padEnd(20)`.
4. `d search` — replace the inline layout with the helper to delete
   duplicated code.
5. `d daemon status` — *deferred.* It's labelled rows, not a table;
   folding it in doesn't pay back.

## out of scope

- ASCII-bordered tables (`cli-table3` style). Our output is dense and
  scrollback-friendly; borders would hurt that.
- Markdown / JSON table output. `--json` flags already exist where
  needed (`daemon status`).
- Headers / sortable columns / interactive tables.
- ANSI-width-aware truncation of column content for surrogate pairs or
  emoji. Our data is ASCII; revisit if/when we surface user-supplied
  prose in a column.

## acceptance

- [ ] `printTable(rows, cols?)` helper exists in `packages/cli/src/table.ts`
- [ ] `formatRelPast` in `relative-time.ts` with tests
- [ ] `d plugin runs` columns line up across all visible rows
- [ ] `d plugin runs` shows relative time by default, exact ISO with `-v`
- [ ] `d plugin runs | cat` emits TSV (no ANSI, no padding)
- [ ] `d collection list` migrated; long names no longer spill
- [ ] `d search` migrated; no behavior change observable from CLI
- [ ] No new runtime dependency added to `packages/cli`
- [ ] No header row anywhere; layout still readable
