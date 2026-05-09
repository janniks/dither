---
status: complete
priority: P1
---

# `dither init` — interactive flow + location concept rename

## Problem Statement

Two related issues with how dither sets up a fresh install today:

1. **`DITHER_HOME` is misnamed.** "Home" reads as "this is where everything
   dither-related lives," which conflates two concerns: dither's working
   state (plugins, grants, runs, locks, qmd index, daemon state — opaque,
   regenerable) and the user's content (the markdown library — the thing
   to back up, sync, version-control). The current default also nests the
   library inside `DITHER_HOME`, which makes the conceptual distinction
   invisible. New users don't realize the library can — and often
   *should* — live somewhere visible like `~/Documents`.

2. **`dither init` is silently default-y.** Run with no flags it just
   writes `config.json` using the nested-library default and exits. The
   user has no chance at install to make an informed choice about library
   location; they'd have to know to look up `--library` after the fact.

## Solution

Two paired changes folded into one spec because they're tightly related —
the interactive prompt is the surface that makes the new naming visible:

### Rename + lookup chain

`DITHER_HOME` → `DITHER_DIR`. Resolved via:

```
1. $DITHER_DIR (explicit)
2. $XDG_CONFIG_HOME/dither (if XDG_CONFIG_HOME set)
3. ~/.dither (fallback — current behavior, macOS-friendly)
```

`DITHER_HOME` is honored as a soft alias for one release: read it when
`DITHER_DIR` is absent, log a one-line deprecation warning, then drop in
the next release.

`dither status` surfaces the two concepts separately, with their env /
config source labels visible.

### Interactive `dither init`

When `--library` is not provided AND stdout is a TTY, prompt the user.
One question for now (library location), with a placeholder example
shown alongside the actual default. Re-prompt on validation failure with
the inline error.

When `--library` is not provided AND stdout is NOT a TTY, exit with a
clear error pointing at the missing flag — don't silently default.

When `--library` is provided, run non-interactively (today's behavior).

`--force` is removed — init is one-shot setup only; reconfiguration is
out of scope here.

`--download` stays as today (default `true`) and is not a prompt; it's
the only other CLI knob and the user almost always wants weights
prefetched.

## User Stories

1. As a new dither user installing for the first time on a TTY, I want
   `dither init` to ask me where my library should live, so that I make
   an informed choice rather than discover the default after the fact.
2. As a new dither user, I want the prompt to show a realistic example
   path (`~/Documents/dither`) alongside the default
   (`<DITHER_DIR>/library`), so that I see what an alternative looks like
   without having to invent one.
3. As a new dither user, I want pressing Enter at the prompt to accept
   the default, so that "default behavior" is the path of zero typing.
4. As a CI/scripted user invoking `dither init` from a pipeline, I want
   passing `--library /some/path` to skip all prompts, so that scripted
   invocations are deterministic.
5. As a CI/scripted user without a TTY, I want `dither init` to fail
   loudly when `--library` is absent, so that misconfigured CI doesn't
   silently land my library in an unexpected nested default.
6. As a returning user, I want `dither init` on an already-configured
   home to be a no-op that prints the existing summary, so that re-running
   the command never destroys my setup.
7. As an XDG-conscious Linux user, I want `XDG_CONFIG_HOME/dither` to be
   honored as the config dir when `DITHER_DIR` is unset, so that dither
   plays nicely with the conventional Linux config location.
8. As a power user with an existing `~/.dither` install, I want the
   fallback chain to land on `~/.dither` so my install keeps working
   without changes after the rename.
9. As a user upgrading across a release, I want `DITHER_HOME` to keep
   working as an alias with a one-line deprecation warning, so I have
   a release window to migrate my shell rc files.
10. As a user inspecting where things live, I want `dither status` to
    print "config dir" and "library" as two distinct rows with their
    respective env/config labels, so the conceptual split is legible at
    a glance.
11. As a user who provided an invalid library path (file, non-writable,
    non-existent parent), I want the prompt to re-ask with the error
    inline rather than crashing, so I can correct typos without
    restarting.
12. As a user finishing a successful interactive init, I want a short
    summary of what was created (config path, library path, weights
    prefetched) plus a one-line "next: dither plugin install …" nudge,
    so I know what to do next.
13. As a plugin developer adding a new prompt to init in the future, I
    want the contract to be "every prompt has a matching CLI flag", so
    that scripted use stays predictable without a `-y`-style escape
    hatch.
14. As a maintainer reviewing prompts in dither, I want a single
    `prompt.ts` module wrapping the chosen library, so that swapping
    implementations is one file.
15. As a developer running tests in non-interactive CI, I want the
    interactive prompt code path entirely bypassed by the `--library`
    flag, so that test runs never hang waiting for stdin.

## Implementation Decisions

### TUI / prompt library: `consola`

UnJS, same ecosystem as citty. Lightweight (text + confirm + arrow-key
select), idiomatic for citty-shaped CLIs. `consola.prompt()` covers v1
needs. Wrapped in a single CLI utility module so swapping to
`@clack/prompts` later (if we hit a feature wall: multi-select, password
input, group cancellation flows) is a one-file change.

`ink` (full-screen React-for-CLI) is deferred until we have a real
multi-pane / live-updating screen. Not needed for prompts.

### Resolution chain

The home resolver checks: `$DITHER_DIR` → `$XDG_CONFIG_HOME/dither` →
`$DITHER_HOME` (with a one-time deprecation warning) → `~/.dither`.
First match wins.

The deprecation warning fires once per process invocation if
`DITHER_HOME` is read. Drops in the release after.

### Interactive trigger

Init enters interactive mode when:
- No existing `config.json`, AND
- `--library` was not supplied, AND
- `process.stdout.isTTY` is truthy.

Otherwise the existing non-interactive path runs (or errors, if
`--library` is missing without a TTY).

### Library prompt

Free-form text input. Pre-filled default: `<DITHER_DIR>/library`. A hint
line shows `~/Documents/dither` as an example alternative — explicitly
labeled as "example" not "default" so users don't confuse the two.

Validation runs after submission (writable directory, mkdir if absent,
realpath canonicalisation — same checks the existing `--library` path
runs through). On failure, re-prompt with the error inline.

### `--force` and `--download`

`--force` is removed entirely. Init is first-run setup. Reconfiguration
moves to a future `dither config` surface; not in scope here.

`--download` stays unchanged (default `true`, can be `--no-download` for
test/CI). Not a prompt — pre-fetching weights is the always-correct
default; asking would just be a question users always say yes to.

### Status command output

`dither status` prints `config dir:` and `library:` as separate rows,
each with a parenthetical noting where the value came from (`env:
DITHER_DIR` / `config: library.path`). The existing `home:` row is
replaced by the two-row split.

### Behavior matrix

| Invocation | Result |
|---|---|
| `dither init` (TTY, no config) | Interactive prompt; library = answer |
| `dither init` (no TTY, no config) | Error: `--library required when not on a TTY` |
| `dither init --library /path` (no config) | Non-interactive; library = `/path` |
| `dither init` (config exists) | Print existing summary, exit 0 |
| `dither init --library /path` (config exists) | Print existing summary, exit 0; flag noted as ignored |

### Modules touched

- **Home resolver** — new lookup chain, deprecation warning for legacy
  env var. Pure logic, easy to test without filesystem.
- **Prompt module** (new) — thin wrapper over `consola.prompt`. One
  helper today (`promptText`), grow as new prompt sites appear.
- **Init command** — branch on TTY + flag presence; otherwise unchanged.
- **Status command** — split output into config-dir vs library rows.
- **Existing tests** — most use `process.env.DITHER_HOME` directly;
  those continue passing because `DITHER_HOME` is honored as a soft
  alias. New `home.test.ts` covers the precedence chain explicitly.

## Testing Decisions

- **Test external behavior, not internals.** Drive the home resolver
  through its public function with various env combinations; assert the
  returned path. Don't poke at the lookup-order constants.
- **`home.test.ts`** — exhaustive: `DITHER_DIR` set wins; `DITHER_DIR`
  unset + `XDG_CONFIG_HOME` set wins; both unset + `DITHER_HOME` set
  emits warning and wins; all unset → `~/.dither`.
- **`init.test.ts`** — extends the existing init tests with: non-TTY
  without `--library` errors with the documented message; non-TTY with
  `--library` runs non-interactively; existing-config invocation is a
  no-op summary print. Interactive TTY path itself isn't unit-tested
  (TTY interaction is fiddly and the wrapper is a thin pass-through to
  `consola`).
- **`status.test.ts`** — assert the two-row "config dir" / "library"
  output and source labels, both for fresh installs and ones with an
  overridden library path.
- **Prior art**: existing `init.test.ts`, `home`-shaped tests across
  `journal.test.ts`, `lifecycle.test.ts`, `search.test.ts` etc. all use
  `process.env.DITHER_HOME` to point at a tmp dir — those keep working
  unchanged thanks to the alias.

## Out of Scope

- Migrating existing `~/.dither/library/` content to a new location.
  Users who want to move can do it manually and re-init from scratch.
- A `dither config` interactive editor for post-init reconfiguration.
  Future, separate spec.
- Localization of prompt text.
- Full-screen TUI / `ink` adoption.
- Stricter XDG support (XDG_DATA_HOME for indices, XDG_STATE_HOME for
  runs, etc.). One config dir, single env var, one XDG variable
  honored — keeps the model crisp.
- A confirmation step before writing `config.json`. Defaults are
  pre-filled per-prompt; an extra "are you sure?" is friction without
  signal.

## Further Notes

- The deprecation warning for `DITHER_HOME` fires from inside the home
  resolver, not from a global init hook — keeps it tied to actual reads
  rather than to startup.
- Realpath canonicalisation on the library path matches the existing
  install-time canonicalisation for file grants. Same rationale: a
  symlink swap later mustn't silently widen the configured library
  scope.
- The end-of-init summary is three short lines (config written, library
  created, weights pre-downloaded) plus a one-line `next: dither plugin
  install <path>` nudge. Keeps users oriented immediately after the
  prompts.
- Pressing Ctrl-C at the prompt should exit cleanly with a non-zero
  status and no partial config.json written. `consola.prompt` propagates
  the cancellation; init catches and exits.
