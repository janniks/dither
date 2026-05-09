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
  Your markdown entries — back this up / sync / git.
  example: ~/Documents/dither
  (default: /Users/jannik/.dither/library)
> _

✓ wrote /Users/jannik/.dither/config.json
✓ created library at /Users/jannik/Documents/dither
✓ pre-downloaded model weights (320 MB)

next: dither plugin install <path>
```

One prompt for now: library. The download step runs unconditionally per
the `--download` flag's default (currently `true`, can be disabled with
`--no-download` for tests/CI). It's not a prompt — pre-fetching model
weights is what the user wants 99% of the time, and asking would just
add a question they always say yes to.

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

### Non-interactive mode

No `-y` / `--yes` flag. **Every prompt has a matching CLI flag.** Pass
all of them and init runs non-interactively. Today the only prompt is
library location, so the only flag is `--library`.

- `dither init --library <path>` → no prompts, uses given path.
- `dither init` on a TTY → interactive prompt for library.
- `dither init` without a TTY (piped, redirected, container) and
  without `--library` → exit with an error pointing at the missing
  flag. Don't silently default.

This keeps scripted use explicit ("you must say what you want") while
keeping interactive use friendly. Adding a future prompt = add a
matching flag, no `-y` semantics to maintain.

### Library default + placeholder

The default stays `<DITHER_DIR>/library` (today's behavior). Pressing
Enter at the prompt accepts that default.

The prompt also shows a *placeholder example* — `~/Documents/dither` —
as guidance so users see what an alternative looks like. The placeholder
is hint text, **not the default**: if the user types nothing and
submits, they get the actual default (`<DITHER_DIR>/library`), not the
placeholder.

```
? Where should your library live?
  Your markdown entries — back this up / sync / git.
  example: ~/Documents/dither
  (default: /Users/jannik/.dither/library)
> _
```

### `--force` removed

Init is first-run setup only. No `--force` flag. If a user wants to
reconfigure, they delete `config.json` (or whatever scoped reset we
later expose) and re-run. Keeps the command's contract crisp:
"one-shot setup, doesn't touch existing config."

A future `dither config reset` or `dither config set library.path …`
command can handle reconfiguration without overloading init. Out of
scope here.

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

| Invocation | Result |
|---|---|
| `dither init` (TTY, no config) | Interactive prompt; library = answer |
| `dither init` (no TTY, no config) | Error: `--library required when not on a TTY` |
| `dither init --library /path` (no config) | Non-interactive; library = `/path` |
| `dither init` (config exists) | Print existing summary, exit 0 (no overwrite) |
| `dither init --library /path` (config exists) | Print existing summary, exit 0 (no overwrite, flag ignored with note) |

## Implementation surface

Changes:
- `packages/cli/src/home.ts` — new resolution chain (DITHER_DIR →
  XDG_CONFIG_HOME/dither → DITHER_HOME alias → ~/.dither). Deprecation
  log for DITHER_HOME usage.
- `packages/cli/src/prompt.ts` — new module wrapping `consola.prompt`.
  Single helper for v1: `promptText({ message, default, hint, validate })`.
- `packages/cli/src/commands/init.ts` — remove `--force` and `--download`
  options? (download stays — it's not a prompt today). Add interactive
  branch when no `--library` and TTY. Error path when no `--library`
  and no TTY.
- `packages/cli/src/commands/status.ts` + `status.ts` — separate output
  for `config dir` vs `library`, with their respective env / config
  source labels.
- `packages/cli/package.json` — add `consola` dependency.
- Tests:
  - `home.test.ts` — resolution chain (DITHER_DIR > XDG > HOME alias >
    fallback).
  - `init.test.ts` — non-TTY path errors when no flag; flag path works;
    existing-config path is no-op.
  - `prompt.test.ts` — deferred (testing TTY interaction is fiddly; the
    wrapper is a thin pass-through).

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
