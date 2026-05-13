---
status: ready
priority: P2
---

# `dither plugin install` — interactive flow + install/run clarity

## Problem Statement

`dither plugin install <path>` is either fully scripted or fully broken.
Required `env` / `files` declared in the manifest must be passed as
comma-joined flags up-front; forget one and the command exits with a
bare error and you re-type the whole command. New users who just ran
`dither init` and got a friendly interactive setup hit a wall at the
very next step.

The manifest has everything needed to ask politely — env defs have
`description` / `default`, file defs have `id` / `name`, plus the plugin
declares `display_name`, `tagline`, `icon`. Today this metadata is
ignored at install.

Separately, the install-vs-run distinction is muddy. `plugin run <path>`
silently installs as a side effect; `plugin install` configures
schedule/watch via the daemon but doesn't fire the plugin; nothing in
the output tells the user which command does which.

## Solution

Two paired changes:

1. **Interactive install on a TTY.** When `dither plugin install <path>`
   is missing inputs the manifest declares — *and* in general for every
   declared env, file, net host, and collection — drop into a TUI flow
   using the same grammar as `dither init` (`promptText` and friends).
   Full review of the manifest's asks: env values, file paths, net
   hosts (multi-select with custom-entry), collection patterns (same,
   plus pattern validation). Final `Proceed? [Y/n]` before grants are
   written. On non-TTY, keep today's behavior but enumerate *all*
   missing required fields in one error rather than one-at-a-time.

2. **Install/run boundary made legible.** Each command ends with a
   one-line `next:` nudge that points at the other command, with a
   schedule preview when the manifest has `schedule`. `plugin run`'s
   path-form continues to call `installPlugin` (no duplication), so the
   interactive flow benefits both commands.

## User Stories

1. As a new user installing a plugin on a TTY, I want missing required
   env values to trigger a prompt instead of an error, so I can paste
   the value without re-running the command.
2. As a new user, I want to see the plugin's title before granting it
   capabilities, so I know what I'm approving.
3. As a security-conscious user, I want to review the network hosts a
   plugin wants before granting them, so I can untrust hosts I don't
   recognize.
4. As that same user, I want to add a host the plugin's manifest
   doesn't declare (e.g. a private mirror), so I'm not forced to edit
   the source.
5. As that same user, I want the same review for collections, with
   inline pattern validation if I add a custom entry, so I catch typos
   before the install completes.
6. As a user with an existing install of the same plugin, I want my
   prior answers pre-filled in the prompts, so reinstall after a code
   change is Enter-Enter-Enter.
7. As a manifest author who bumps the plugin and adds a new declared
   env, I want existing installers to see a prompt for the new field
   (no pre-fill, since they never answered), so the new ask isn't
   silently skipped.
8. As a CI / scripted user, I want non-TTY installs without required
   flags to exit non-zero with a single error listing every missing
   required field, so one CI run gives me the full fix list.
9. As a CI / scripted user, I want passing every required flag to keep
   today's non-interactive behavior, so my pipeline doesn't change.
10. As a user installing a `schedule:`'d plugin, I want a one-line
    "next run: in 4h" preview after install, so I know when it'll
    actually fire.
11. As a user installing a `watch:`'d plugin, I want to be told it
    will run automatically and pointed at `plugin run` for a one-shot
    manual fire, so I don't sit waiting.
12. As a user installing an on-demand plugin (no schedule, no watch),
    I want `next: dither plugin run <name>` so I know the obvious next
    step.
13. As a user invoking `plugin run <path>`, I want any missing required
    inputs to trigger the same prompts as `plugin install`, so the two
    entry points behave identically up to the moment of execution.
14. As a user reading `--help` for install or run, I want each command
    to cross-reference the other, so I can find the right tool when I
    hit an unknown-flag error.
15. As a user picking a file path at the prompt, I want to drag-and-drop
    from Finder into the terminal, so I don't have to type long paths.
16. As a user mid-prompt, I want Ctrl-C to abort cleanly with no
    half-installed state, so I'm never stuck with partial grants.
17. As a maintainer, I want the "what to ask" logic to be a pure
    function I can unit-test against (manifest, existing grants, flags)
    → plan, so the interactive surface stays a thin shell over consola.

## Implementation Decisions

### Entry points

`installPluginOrExit` at the CLI command boundary is the single
interactive surface. Both `installSubcommand` and `runSubcommand`'s
path-form call it; `runSubcommand`'s name-form never installs and
never prompts (its grant flags remain pure per-run overrides).

`installPlugin()` in `plugin-install.ts` stays I/O-free — no prompts
pushed into the library. The daemon and tests keep using it unchanged.

### Scope of prompts

Full review of the manifest's asks (Q2 = c):

- **env** — one select per declared env: `[Use default: <default>] /
  [Enter a literal value] / [Read from global dither env] / [Skip]`.
  Default option is shown only when the manifest declares one; Skip is
  shown only when not required. Literal entry drills into a text
  prompt.
- **files** — simple text prompt per declared file. No kind/extension
  hints. Validation reuses `resolveFiles` checks (exists, realpath,
  required). Users typically drag-and-drop from Finder into the
  terminal.
- **net** — `promptMultiSelect` with all manifest hosts pre-checked,
  plus a `+ Add custom host…` row. Selecting the add row pops a text
  prompt and appends to the checklist.
- **collections** — same shape as net, plus `validateGrantPattern` run
  on any custom entry (re-prompt on invalid pattern).

A title-only header (`<display_name || name>@<version>`, truncated to
~60 chars) prints once at the top of interactive mode. No icon, no
tagline, no description block — a plugin can't use header decorations
to mislead about what's about to be installed.

### Pre-fill from existing grants

When `grants/<name>.json` already exists, the planner pre-fills each
prompt with the user's prior answer:

- env literals → text prompt pre-fill on the "Enter a literal" path,
  selected by default in the parent select.
- env allow-refs → "Read from global dither env" pre-selected.
- file paths → text prompt pre-fill.
- net hosts → existing granted hosts pre-checked (intersected with
  manifest's current declaration; new manifest hosts also shown
  unchecked, so the user explicitly approves them).
- collections → same as net.

CLI flags always win over pre-fills.

### Final confirmation

After all prompts, print a summary block (the running `✓ Field: value`
ledger accumulated during the flow), then `Proceed? [Y/n]`. Enter or Y
proceeds; N aborts cleanly with no grants written and no plugin code
copied. Matches the safety framing of the full-review scope.

### Non-TTY behavior

Same as today, plus all-missing enumeration:

- TTY absent + missing required input → resolve every required field
  in one pass, collect all missing names, exit 1 with a single error
  listing them all (e.g. `error: missing required env: OPENAI_API_KEY,
  REPO_URL. missing required file: config_path. pass --env / --file
  or run on a TTY for interactive setup.`).
- TTY absent + everything satisfied → today's silent install.

No `--non-interactive` / `--yes` flag for now (deferred).

### Install/run cross-references

- `installSubcommand.meta.description` mentions `plugin run` (and
  vice versa) so flag-error → `--help` lands on the right pointer.
- Each command ends with one `next:` line:
  - install + manifest has `schedule` → `next run: <relative> (<absolute>)`
    on its own line, then `next: dither plugin run <name>` for a manual fire.
  - install + manifest has `watch.collections` → `next: this plugin runs
    automatically when files in <coll> change. 'dither plugin run <name>'
    fires once.`
  - install + neither → `next: dither plugin run <name>`.
  - `run <path>` → `note: grants persisted. future runs: 'dither plugin
    run <name>'.`

Schedule preview reuses `schedule-parser.ts`'s next-fire computation.

### Modules touched

- **`prompt.ts`** — extend with `promptSelect` (single-choice list) and
  `promptMultiSelect` (pre-checked checklist with `+ Add custom…` row
  and a validator hook). Same wrapping pattern as `promptText`.
- **`plugin-install-interactive.ts` (new)** — two halves:
  - `planInstall(manifest, existingGrants, flags) → PromptPlan` — pure
    function. Decides per field: skip (flag wins), prompt fresh, or
    prompt with pre-filled default. Also returns the full
    missing-required list used by non-TTY error enumeration.
  - `runInstallPrompts(plan) → InstallOptions` — walks the plan,
    drives the prompt helpers, returns options ready for
    `installPlugin()`.
- **`plugin-install.ts`** — `resolveEnv` / `resolveFiles` gain a
  collect-don't-throw mode the planner uses. Throw-on-first-miss
  remains the default for direct callers.
- **`commands/plugin.ts`** — `installPluginOrExit` becomes the
  interactive entry: plan → on missing + TTY, run prompts and merge →
  on missing + non-TTY, print enumerated error → call `installPlugin`.
  Adds the title header, final `Proceed?` confirm, and `next:` lines.
  `meta.description` cross-references.
- **`schedule-parser.ts`** — reused, not modified.

## Testing Decisions

External behavior only, no consola internals.

- **`planInstall` (pure)** — table-driven: manifest × existing-grants ×
  flags → expected `PromptPlan`. Covers: fresh install missing required
  env; reinstall pre-fills literals and allow-refs; new manifest field
  added since prior install shows up unprefilled; flag wins over
  pre-fill; pattern validation surfaces in plan.
- **`installPluginOrExit` non-TTY** — missing required env + file → one
  error listing both; all satisfied → install succeeds silently.
- **Pre-fill matrix** — given existing grants for a plugin, prompt
  defaults map exactly: literal → literal pre-fill; allow-ref → select
  pre-selected; net/collection → pre-checked intersection.
- **TTY interactive path itself is not unit-tested** — same call as
  init's spec (consola interaction is fiddly; the wrapper is a thin
  pass-through).

Prior art: `init.test.ts` `captureLogs` pattern (spy `console.log` +
`process.stdout.write`), and the existing `plugin-host.test.ts` for
plugin-install-shaped flows.

## Out of Scope

- A `secret: true` field on env defs (deferred — full select per env
  covers the literal-vs-allow-env choice for v1).
- A `--non-interactive` / `--yes` escape hatch on TTY runs (deferred;
  pipe stdin from /dev/null if needed today).
- Enforcing `extensions[]` on file prompts (manifest currently uses it
  for display only; a separate change).
- Native file-picker (drag-and-drop into the terminal is the v1
  affordance).
- Migrating today's `--env` / `--file` / `--allow-*` flag syntax. They
  keep working unchanged; the prompt flow only fires for gaps.
- Re-prompting on a `plugin run <name>` (already-installed) invocation.
  Override flags stay pure per-run; never persisted, never prompted.

## Further Notes

- Ctrl-C anywhere mid-prompt rejects cleanly (consola's cancel:reject
  semantics, same as init). Wrapping caller exits 130 with no partial
  state.
- The `confirm()` line after each prompt accumulates a running ledger
  on stdout — that ledger *is* the final summary that precedes the
  `Proceed?` step. No separate summary block.
- New manifest fields appearing on reinstall (env added since the user
  last installed) show up as fresh prompts with no pre-fill, so the
  user is explicitly informed of the new ask.
- The planner's "skip vs prompt" decision is the deep-module win — all
  branching logic is pure and trivially unit-testable; the prompt
  helpers in `prompt.ts` are dumb I/O drivers.
