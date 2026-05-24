# plugin-install-ux

## Problem Statement

Running `dither plugin install plugins/imessage` produces an install flow with
five rough edges that, together, make the command feel unfinished and — most
importantly — violate the safety-first promise of the install dialog:

1. Two stacked `┌─ from plugin ─┐` boxes back-to-back (package description +
   first field description), with identical chrome — looks like a rendering
   bug.
2. The `MESSAGES_DIR` folder prompt has no visible default, even though
   `~/Library/Messages` is the canonical path for the iMessage plugin.
3. The macOS Full Disk Access warning prints as an indented, uncolored
   stderr block that's hard to scan and looks unlike the rest of Dither's
   voice.
4. The `x-apple.systempreferences:` URL inside that warning is dumped raw,
   which reads as a command/code artifact rather than something to click.
5. Install ends with `next run: in 5m 26s (…)` and silently starts a
   background daemon — the user never confirmed that the plugin's
   declared cron schedule should be enabled. **This is the safety issue:**
   a one-shot install command shouldn't enroll the user in a recurring
   background job without consent.

## Solution

Three shifts in the install dialog, plus minor visual polish:

- **Consent for recurring work.** Before writing grants, the interactive
  flow asks whether to enable the manifest's `schedule` (and `watch`)
  declarations. The user's effective choice — declared, custom cron, or
  manual-only — is persisted as `schedule` at the top of the grants file.
  The daemon reads from there, so "Manual only" means the daemon never
  schedules the plugin and `next run:` is not printed.
- **First-class macOS FDA handoff.** When an install grant lands inside a
  TCC-protected folder, Dither prints a styled note in its own voice and
  prompts `Open System Settings now to grant Full Disk Access? [Y/n]`. On
  Yes we `openBrowser(FDA_SETTINGS_URI)`; on No the URL stays in the note
  for later. The raw URL never appears as the only call-to-action.
- **Defaults that actually surface.** `promptText` auto-derives an
  `(ENTER for <default>)` hint when `default` is set. `default_hint` is
  removed from the manifest schema — one attribute does the job.

Plus: drop the duplicate top-level "from plugin" description box when
per-field descriptions follow, so prose doesn't stack identical chrome.

## User Stories

1. As a Dither user installing `imessage`, I want to be asked whether the
   plugin should run every 15 minutes, so that I'm never enrolled in a
   recurring background job by surprise.
2. As a Dither user, I want a clear "Manual only" option in the schedule
   prompt, so that I can install a scheduled plugin and fire it on demand
   without committing to the cron.
3. As a Dither user comfortable with cron, I want a "Custom cron…" option
   in the schedule prompt, so that I can override the manifest's declared
   cadence at install time.
4. As a Dither user installing a plugin that needs a canonical path
   (`~/Library/Messages`, `~/Library/Application Support/Slack/…`), I want
   to see the default inline in the prompt and press Enter to accept, so
   that I don't have to type a path the plugin already knows.
5. As a Dither user on macOS, I want a single styled note when a granted
   folder is TCC-protected, followed by a one-keystroke offer to open
   System Settings, so that the Full Disk Access handoff feels integrated
   instead of like a wall of stderr.
6. As a Dither user, I want plugin-supplied prose to render in a single
   "from plugin" box per logical section, so that descriptions don't
   stack identical chrome when both the package and the first field
   declare one.
7. As a Dither user, I want `next run: …` to only print after I've
   actually consented to scheduling, so that the install output is an
   honest record of what the command did.
8. As a Dither user choosing "Manual only", I want `dither plugin list`
   and the daemon to honor that choice, so that opting out at install
   time has actual teeth.
9. As a plugin author, I want a single `default` attribute on file
   declarations, so that I'm not asked to maintain two parallel strings
   (`default` + `default_hint`) when one will do.

## Implementation Decisions

### Modules

- **`packages/cli/src/manifest.ts`** — drop `default_hint` from the file
  declaration schema. `default` stands alone. The displayed hint is
  derived from the default value at prompt time.
- **`packages/cli/src/prompt.ts`** — `promptText` accepts an existing
  `default`; the message line auto-appends `(ENTER for <default>)` when
  a default is present. Existing callers that already embed a hint in
  their `message` continue to work.
- **`packages/cli/src/plugin-install-interactive.ts`** —
  - Drop the top-level package-description box when at least one
    per-field plugin-text block will follow it.
  - Stop reading `default_hint`.
  - New step in `promptInteractive`: schedule consent (only when the
    manifest declares `schedule`). Surface as a select with options
    `[As declared (<human interval>) | Manual only | Custom cron…]`.
    The "Custom cron…" option opens a follow-up text prompt validated
    via the existing `parseSchedule`. Result is stamped into the
    `InstallInputs` shape (new field) and persisted as
    `grants.schedule` at the top level.
  - New step: watch consent (only when the manifest declares
    `watch.collections`). Simpler Y/n confirm — no override path —
    persisted as `grants.watch.enabled` (or by omitting/keeping the
    `watch` block in grants).
- **`packages/cli/src/plugin-install.ts`** — persist the consented
  schedule + watch state into the grants blob. Grants file gains a
  top-level `schedule` field (`string | null`) and the existing
  `manifest` block stays as declared. Remove the call to
  `maybeWarnInstall` from here — emit a structured result instead.
- **`packages/cli/src/tcc-hint.ts`** — replace `maybeWarnInstall`'s
  ad-hoc `console.error` block with a function that returns a structured
  `{ path, callerBinary, settingsUri }` object (or null). The renderer
  lives in the CLI command layer alongside the open-Settings prompt.
- **`packages/cli/src/commands/plugin.ts`** —
  - After `installPlugin` returns, if the TCC helper reported a
    protected path, render a Dither-voice styled note and prompt
    `Open System Settings now to grant Full Disk Access? [Y/n]`. On
    Yes call `openBrowser(FDA_SETTINGS_URI)`.
  - Gate `ensureDaemonForPlugin` on the consented `schedule`/`watch`
    state, not the manifest declaration.
  - Gate `printInstallHint`'s `next run:` line on the same consent —
    when the user picked "Manual only", print the manual-fire hint only.
- **`packages/cli/src/scheduler.ts` / `daemon.ts` / `plugin-list.ts`** —
  read `grants.schedule` instead of `grants.manifest.schedule`. No
  fallback; old grants files without the field are treated as
  manual-only (clean break — the user can reinstall).
- **`packages/cli/src/global-env.ts` (or wherever `ditherText` will
  live)** — new helper in `prompt.ts`: `ditherText(message)` renders
  Dither's own voice as a styled box visually distinct from
  `pluginText` (e.g. different border color / label "note" instead of
  "from plugin"). Used by the FDA note.
- **`test.local/plugins/imessage/package.json`** *(gitignored, user's
  local sandbox)* — add `default: "~/Library/Messages"` to the
  `MESSAGES_DIR` file declaration so the new ENTER-for-default hint
  has something to surface. Repo-tracked plugin fixtures that use
  `default_hint` (e.g. `test.local/plugins/slack/`) are updated to
  drop the attribute.

### Schedule consent — exact prompt shape

When the manifest declares `schedule`:

```
schedule (declared: */15 * * * * — every 15 minutes)
> [x] Enable as declared (every 15 minutes)
  [ ] Manual only — fire with 'dither plugin run imessage'
  [ ] Custom cron…
```

Choosing "Custom cron…" opens a text input validated by `parseSchedule`;
re-prompts on invalid. The result is persisted as the user's effective
schedule.

### Watch consent — exact prompt shape

When the manifest declares `watch.collections`:

```
watch — this plugin runs automatically when files in
  messages/** change. Enable? [Y/n]
```

Y persists the watch declaration to grants; N drops it.

### Grants schema diff

- Add top-level `schedule: string | null` — the user's effective cron,
  or `null` for manual-only.
- Add top-level `watch: { collections: string[]; glob?: string } | null`
  — the user's effective watch declaration, or `null` if disabled.
  (Optional: simply omit when disabled.)
- `manifest.schedule` and `manifest.watch` remain as declared (for
  diff / debug); the daemon ignores them.

### Box dedupe rule

`promptInteractive`'s opening sequence becomes:

- Print header (unchanged).
- **If** the plugin has at least one field-level description that will
  render below: skip `pluginText(parsed.description)`.
- **Else:** render `pluginText(parsed.description)` as today.

Concretely: when `manifest.env` or `manifest.files` contains any entry
with a non-empty `description`, the package-level description box is
suppressed.

### Auto-derived ENTER hint

`promptText({ message, default })` produces the prompt line as:

```
<message> (ENTER for <default>)
```

— concatenated when the caller didn't already include `(ENTER` in
`message`. If the caller wants a different phrasing they pass it
inline in `message` and leave `default` unset (or set `default`
without the auto-append by also passing a sentinel — out of scope).

## Testing Decisions

- **`promptInteractive` schedule consent** — extend the existing
  `plugin-install-interactive.test.ts` fixture-driven coverage. Test
  three cases: declared chosen, manual chosen, custom cron entered and
  validated. Assert the resulting `InstallInputs.schedule` value.
  Existing tests already mock the consola prompt layer — reuse that.
- **`promptInteractive` watch consent** — same file. Two cases: Y and N.
- **`promptInteractive` description dedup** — assert that when a field
  description is present the package-level description doesn't render.
- **`promptText` ENTER-hint auto-derivation** — `prompt.ts` doesn't
  have its own test file today; add focused tests for the message
  composition (no need to drive consola). The hint string is pure
  derivation.
- **Grants persistence** — `plugin-install.test.ts` already covers the
  grants write path. Extend to assert `grants.schedule` is set to the
  consented value and `grants.manifest.schedule` is preserved.
- **Daemon ignores manifest.schedule** — add a test in
  `daemon.test.ts` (or wherever scheduler loading is covered) that
  asserts a grants file with `schedule: null` does not produce a
  schedule entry, even when `manifest.schedule` is set.
- **TCC structured return** — `tcc-hint.test.ts` adjusts: instead of
  asserting the stderr blob, assert the returned structure (`path`,
  `callerBinary`, `settingsUri`).
- **FDA open-Settings prompt** — orchestration lives in the command
  layer; covered via an integration-style test that injects a fake
  `openBrowser` and asserts it's called on Yes / not called on No.
- **No mocks of file system or grants files** beyond what's already in
  the suite; follow the existing pattern of writing to a tmp home.

## Out of Scope

- Editing the cron via a preset list — only "as declared / manual /
  custom cron text" lives in this spec. A preset library
  (`every-5m`, `daily`, …) is a future feature.
- Mutating an installed plugin's schedule choice without reinstall.
  `dither plugin schedule set <name> <cron>` is a follow-up.
- Migrating existing grants files. Per user direction, no migration —
  old grants without `schedule` are treated as manual-only. A reinstall
  re-prompts.
- Watch override (custom collections / glob). Watch consent is Y/n in
  this spec; richer editing is deferred.
- Allowing plugin manifests to suppress the FDA prompt. The flow is
  always offered when a TCC prefix is detected.
- Refactoring `ensureDaemonForPlugin` itself. We only change *when*
  it's called; how it starts the daemon is unchanged.

## Further Notes

- Removing `default_hint` is a manifest schema break. The only known
  consumer is `test.local/plugins/slack/package.json` (gitignored
  sandbox). External plugin authors using `default_hint` will need to
  fold the text into `default` or `description`.
- The Dither-voice box helper (`ditherText` or equivalent) is a small
  module born from this spec. If a second use-case shows up (other
  install-time advisories), it earns its keep; if not, we revisit.
- `formatFdaError` (used by the runtime FDA failure path) stays as-is
  for now — it's a different surface (error output, not install
  prompt). A follow-up could unify both, but they have different
  audiences (post-mortem vs forward-going) and different ceilings on
  interactivity.
