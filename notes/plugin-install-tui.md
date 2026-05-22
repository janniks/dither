# plugin install TUI — rough edges

Hit while installing the Slack plugin (2026-05-22). Some fixed in
`dc48984` / follow-up; others are bigger-picture.

## Fixed

- **Two prompts per env collapsed to one.** The "literal vs read from
  global" select used to render unconditionally; it now only appears when
  a matching global env value actually exists. After the value lands,
  `confirm()` collapses the prompts into a single `✓ NAME: value` line.
- **`~` expansion + shell-escape stripping.** `path.resolve` doesn't
  expand `~`, so `~/Library/Application Support/...` resolved against
  cwd. Added `untildePath` + `normalizePath` (strips `\` escapes, unwraps
  surrounding quotes). Applies to both the prompt path and the
  `--file NAME=PATH` flag.
- **`files[].default` + `default_hint` on the manifest.** Plugin authors
  declare a canonical path (e.g. macOS Slack desktop's leveldb) and the
  prompt Enter-accepts it. Hint shown inline.
- **Net/collections multi-select + add-loop killed.** Manifest is the
  source of truth; `--allow-net` / `--allow-collection` flags override.
  No picker, no `Additional host to grant (blank to stop)` flow. One
  `✓ net: a, b` line either way.
- **Proceed-with-install yes/no removed.** Every prior prompt already
  confirmed its value; the extra Y/n added friction with no signal.
- **Plugin SDK exposes `input.net`.** Eliminates the
  "manifest declares slack.com AND code hardcodes slack.com" duplication.
  Plugin reads its own host allowlist from the input file.

## Still rough

- **Consola text-prompt paste handling.** Pasting a value that contains
  newlines (e.g. the prompt's own echoed line copied from scrollback)
  gets accepted as input verbatim. Saw `value = "✔ Path for SLACK_LEVELDB"`
  literal. Workaround: ship a default so users press Enter, no paste.
  Real fix probably requires switching to a different prompt lib (clack,
  enquirer, custom raw-mode reader) or filtering paste content.
- **Re-prompt on validation failure leaves cruft.** When the path
  validator rejects, consola repaints the prompt above the warning, but
  the wider terminal layout (devtool resize, paste artifacts) can stack
  multiple `✔ Path for X` lines. The whole class of bugs goes away when
  there's a sane default + Enter-to-accept.
- **No "advanced review" mode.** Killed the picker outright. If a user
  wants to deselect a manifest-declared host without a flag, they have
  to pass `--allow-net=""`. Acceptable for now; revisit when a real
  need shows up.
- **Consola's `select` returns option objects in some versions, bare
  values in others.** `promptSelect` already normalizes; flag for future
  prompt-lib swap.
- **Install summary at the end is missing.** After install, we print
  `installed slack@0.0.1` and a `next: ...` nudge — but the user can't
  see a recap of what was granted. The per-line `✓` confirmations stay
  in scrollback, which is the dither pattern, but at the moment of
  scrolling up to verify nothing accidentally got auto-accepted, the
  `--review` style flag (deliberately not built) would be nice.

## Out-of-scope / parking lot

- **Prompt lib swap.** Consola is fine for short ack/confirm but the
  multi-line cursor math (`moveCursor(-2)` + `clearScreenDown`) is
  fragile. If the user wants a richer TUI (live filter on multi-select,
  paste detection, inline help), worth a real eval of clack /
  enquirer / @inquirer/prompts. Keep `prompt.ts` as the only abstraction
  layer so swap stays local.
- **Manifest `default_hint` could carry multiple platform paths.** Right
  now it's a single freeform string. A future shape:
  `defaults: { darwin?: string, linux?: string, win32?: string }` — pick
  based on `process.platform` at install. Slack is macOS-only-for-now so
  YAGNI today.

## Related code

- `packages/cli/src/plugin-install-interactive.ts` — the install flow
- `packages/cli/src/prompt.ts` — TUI primitives (`promptText`,
  `promptSelect`, `confirm`, `untildePath` etc.)
- `packages/cli/src/manifest.ts` — schema (FileDef gains `default`,
  `default_hint`)
- `packages/plugin/src/index.ts` — SDK (PluginInput gains `net: string[]`)
- `packages/cli/src/plugin-run.ts` — writes `net` into input.json
