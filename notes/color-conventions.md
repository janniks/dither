---
status: thinking
priority: P2
---

# Color conventions across the dither CLI

## Why

Color is currently ad-hoc — some commands use plain `console.log`,
others lean on `consola` for log levels (which colors automatically),
nothing explicitly maps semantic meaning to a color choice. The
result: green/red/yellow appear inconsistently, and adding new commands
means re-inventing the palette.

A single thin convention keeps the CLI legible without overspending
on a "design system."

## Library

`picocolors` — explicit dep. Tiny (<5 KB, zero deps), auto-detects TTY,
respects `NO_COLOR`. consola v3 doesn't re-export color helpers (uses
its own internal styling), so we pull `picocolors` directly.

**Use `picocolors`'s named functions** (`green`, `yellow`, `red`,
`dim`, `bold`, `cyan`). Don't reach for `chalk`, `colorette`, or
`ansi-colors` — `picocolors` is the lightest and what consola itself
uses internally.

```ts
import pc from "picocolors";
console.log(pc.green("✓") + " ok");
```

## Semantic palette

Five roles. Anything more is overkill at our scale.

| Role | Color | When |
|---|---|---|
| **success** | `green` | Operation completed cleanly. `✓` glyphs. `daemon: running`. |
| **warning** | `yellow` | Recoverable issue or stale state. `⚠` glyphs. Library missing. Deprecation notices. Retryable failures. |
| **error** | `red` | Hard failure. `✗` glyphs. Aborts. NotInitialized. |
| **info** | `cyan` | Notable but neutral facts. Section headers in `status`. Run IDs. Hostnames. URLs. |
| **muted** | `dim` | Secondary detail. Empty placeholders (`—`). Default values in prompts. Source attributions. Daemon "not running". |

Defaults stay the terminal's default color. Don't paint plain values.

## Glyphs

Pair color with a glyph so colorblind / no-color users still get the
signal:

- `✓` for success (after color: `green("✓")`).
- `⚠` for warning (`yellow("⚠")`).
- `✗` or `✘` for error (`red("✗")`).
- `→` or `next:` for nudges (`cyan("next:")`).
- `—` for unknowable values (`dim("—")`).

`NO_COLOR=1` strips the color but keeps the glyph, so the structure
survives.

## What to avoid

- **Don't color the value itself unless it carries meaning.**
  `library: /path` stays uncolored. `daemon: running` colors only the
  "running" word, not the path.
- **Don't use background colors.** Background highlight is loud and
  rarely renders the same across terminals.
- **Don't bold for emphasis arbitrarily.** Reserve `bold` for one
  thing (e.g. the headline of a multi-line warning); don't sprinkle.
- **Don't combine more than two effects.** `red`+`bold` is fine.
  `red`+`bold`+`underline` is doing too much.
- **Don't color JSON output.** `--json` mode is for machines —
  `colorette` auto-disables on non-TTY pipes, but be explicit when
  emitting JSON.

## Convention for command authors

- Import `colorette` directly: `import { green, yellow, red, cyan, dim, bold } from "colorette"`.
- Keep the painted region tight: paint the glyph + key word, leave
  the rest plain.
- Treat the table above as the contract. If you want a new role
  (e.g. "branch", "remote"), extend the table in this note first.
- For multi-line warnings or success summaries, consider `consola.warn`
  / `consola.success` — those handle prefix + color in one shot.

## Example: status output (per `specs/status-output-DRAFT.md`)

```
DITHER_DIR=/Users/jannik/.config/dither     ← cyan (info)

config dir:  /Users/jannik/.config/dither
library:     /var/folders/.../entries  yellow("⚠ missing — directory does not exist")

plugins:     17
collections: dim("—")    dim("(library missing)")
entries:     dim("—")    dim("(library missing)")

daemon:      dim("not running")
```

Uncolored values where the value is just data; semantic colors only
on the things that change meaning (the warning, the unknowables, the
"not running" state).

## Out of scope

- Theming / user-configurable palettes.
- Color in TUIs (full-screen `ink` output) — different concern, defer.
- Markdown-style formatting in CLI output (we're not writing docs).

## Cross-references

- `specs/status-output-DRAFT.md` — first applied use of these
  conventions.
- `notes/json-output-audit.md` — `--json` mode never colors.
