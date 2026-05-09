---
status: draft
priority: P1
---

# `dither init` — interactive flow + location concept rename (DRAFT)

## Problem

Two related issues with how dither sets up a fresh install today:

1. **`DITHER_HOME` is misnamed.** "Home" implies "this is where everything
   dither-related lives," which conflates two concerns:
   - *Working state* (plugins, grants, runs, locks, qmd index, daemon
     state) — opaque, regenerable, not the user's content.
   - *Content* (the markdown library) — the user's actual data, the thing
     to back up / sync / git.
   The current default nests the library inside `DITHER_HOME`, which makes
   the conceptual distinction invisible. Users don't realize the library
   can — and often *should* — live somewhere visible like `~/Documents`.

2. **`dither init` is silently default-y.** With no flags, it just writes
   config.json using the nested-library default and exits. A new user
   has no chance to make an informed choice about library location at
   install — they'd have to know to look up the `--library` flag.

   Existing flow:
   ```
   $ dither init
   dither initialized at /Users/jannik/.dither
     library: /Users/jannik/.dither/library
   ```
   No questions. No hint that the library could go elsewhere.

## Solution

### Part A — Rename + lookup chain

Rename `DITHER_HOME` → `DITHER_DIR`. Resolve the config dir via:

```
1. $DITHER_DIR (explicit)
2. $XDG_CONFIG_HOME/dither (if XDG_CONFIG_HOME set)
3. ~/.dither (fallback — current behavior, macOS-friendly)
```

Keep `DITHER_HOME` honored as a soft alias for one release: read it
when `DITHER_DIR` is absent, log a one-line deprecation note, then drop.

`dither status` surfaces the two concepts separately:

```
config dir: /Users/jannik/.dither
  (env: DITHER_DIR)
library:    /Users/jannik/Documents/dither
  (config: library.path — set by `dither init --library`)
plugins:    3
collections: 5
entries:    12,847
```

### Part B — Interactive `dither init`

When `--library` is *not* provided AND stdout is a TTY, walk the user
through the choice instead of silently defaulting. Use `consola` (UnJS,
same ecosystem as citty) for prompts.

Flow:

```
$ dither init

Welcome to dither.

? Where should your library live?
  Your library is the folder containing all your markdown entries —
  it's the part you'll back up, sync, or version-control.
  (default: /Users/jannik/.dither/library)
> _

? Pre-download model weights for search? (Y/n) _

✓ wrote /Users/jannik/.dither/config.json
✓ created library at /Users/jannik/Documents/dither
✓ pre-downloaded model weights (320 MB)

next: dither plugin install <path>
```

Each prompt shows:
- A short question.
- One-sentence rationale (why this matters, what they're choosing).
- A pre-filled default they can accept by hitting Enter.
- Examples in a hint line where useful.

The library question takes free-form text and validates after submission
(directory writable, no existing library at that path, etc.). Re-prompt
on validation failure with the error message inline.

## Decisions

### TUI / prompt library: `consola`

Surveyed candidates:

| Library | Ecosystem | Weight | Verdict |
|---|---|---|---|
| `consola` | UnJS (citty's family) | Light | **Pick.** Same family, idiomatic, sufficient for our needs. |
| `@clack/prompts` | independent | Light | Backup. More polish (cancellation, group flows), but separate ecosystem. |
| `@inquirer/prompts` | Inquirer | Medium | Featureful but heavier; overkill for init. |
| `prompts` (terkelg) | independent | Light | Older, less active. |
| `enquirer` | independent | Light | Fine but not a clear win over consola. |
| `ink` | React for CLI | Heavy | **Future**, for full-screen TUIs (file display, dashboards). Not for prompts. |

`consola.prompt()` covers our v1 needs (text input, confirm, select with
arrow-key navigation). If we later need multi-select, password input,
or grouped flows with cancellation, re-evaluate clack.

**Single import point**: `packages/cli/src/prompt.ts` wraps `consola`'s
prompts in dither-shaped helpers. Anywhere in the CLI that needs a
prompt imports from this module. Swapping libraries later is one file.

### Bypass triggers

Skip the interactive flow and use defaults when:
- `--library <path>` is provided (current behavior).
- `--yes` / `-y` flag is set (CI / scripted use).
- stdout is not a TTY (piped, redirected, headless container).
- `--force` is set without `--library` (re-init keeps existing path
  unless overridden).

Library default in non-interactive mode: `<DITHER_DIR>/library` (today's
behavior).

### Library default change?

**No.** The default stays `<DITHER_DIR>/library`. The interactive flow
doesn't change defaults — it makes the choice *visible* and lets the
user opt out of nesting at install time. Power users who want library
elsewhere set `--library`; everyone else accepts the default and never
thinks about it.

### Future: arrow-key select

For init we use plain text input + confirm. Once we have a use case for
selection (e.g. picking a plugin to enable from a list, browsing
collections), we use `consola.prompt({ type: "select" })` with
arrow-key navigation. Same library, no new dep.

### Future: file content display / live screens

Out of scope. When we have a use case (live `dither status` dashboard,
plugin install browser with previews, etc.), evaluate `ink` separately.
Don't pre-adopt.

## Behavior matrix

| Invocation | Interactive? | Library path |
|---|---|---|
| `dither init` (TTY, no config) | Yes | from prompt |
| `dither init` (no TTY) | No | `<DITHER_DIR>/library` |
| `dither init -y` | No | `<DITHER_DIR>/library` |
| `dither init --library /path` | No | `/path` |
| `dither init --library /path -y` | No | `/path` |
| `dither init --force` (TTY, has config) | Yes (re-prompts with existing as default) | from prompt |
| `dither init --force --library /path` | No | `/path` |
| `dither init` (TTY, has config, no --force) | No | unchanged (prints existing summary) |

## Implementation surface

Changes:
- `packages/cli/src/home.ts` — new resolution chain (DITHER_DIR →
  XDG_CONFIG_HOME/dither → DITHER_HOME alias → ~/.dither). Deprecation
  log for DITHER_HOME usage.
- `packages/cli/src/prompt.ts` — new module wrapping `consola.prompt`.
  Helpers: `promptText({ message, default, validate })`,
  `promptConfirm({ message, default })`. Add as needed.
- `packages/cli/src/commands/init.ts` — add interactive branch when no
  `--library` and TTY. Use `prompt.ts` helpers. Existing non-interactive
  path unchanged.
- `packages/cli/src/commands/status.ts` + `status.ts` — separate output
  for `config dir` vs `library`, with their respective env / config
  source labels.
- `packages/cli/package.json` — add `consola` dependency.
- Tests:
  - `home.test.ts` — resolution chain (DITHER_DIR > XDG > HOME alias >
    fallback).
  - `init.test.ts` — non-TTY path skips prompts; existing tests continue
    passing.
  - `prompt.test.ts` — wrapper module sanity (deferred — testing TTY
    interaction is fiddly; the wrapper is a thin pass-through).

## Out of scope

- Migrating existing `~/.dither/library/` content to a new location.
  Users who want to move can do it manually + `dither init --force --library <new>`.
- Localization of prompt text.
- Full-screen TUI or any reactivity beyond single-line prompts.
- A separate `dither config` interactive editor (would be a follow-on if
  there's demand).

## Open questions

- Confirmation step before writing config.json?
  - Pro: visible "you're about to commit to these settings" step.
  - Con: adds a question; users will hit Enter without thinking.
  - **Recommend**: skip the explicit confirm. Defaults are already
    pre-filled in each prompt; the user already had a chance per
    question.
- Show a one-line summary at the end of init listing what was created
  and where? (Yes — keeps users oriented after the prompts.)
- Should `dither init` print a follow-up nudge ("now run `dither plugin
  install <path>`")? (Yes, useful onboarding.)
