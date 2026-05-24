# spec: plugin install consent

## Problem Statement

When the user runs `d plugin install`, several grants the plugin
requests reach `~/.dither/grants/<name>.json` without any user
interaction:

- `net` hosts and `collections` patterns from the manifest are
  silently auto-accepted and printed as `✓ collections: messages/**`
  in scrollback. The `✓` reads as "I confirmed this" — but no prompt
  ever fired.
- `env` values with a manifest `default` are silently taken; the user
  never sees them in scrollback at all.
- On reinstall, a manifest update that *widens* the request (new host,
  new collection pattern) appears as a longer comma-separated `✓` line
  with no diff and no prompt. A hostile plugin update can quietly
  expand its sandbox; the user's only signal is a slightly longer
  string.

The earlier multi-select/add-loop UX for these grants was removed
because it felt clunky. The pendulum swung past "no friction" to "no
consent."

## Solution

Every grant the plugin requests becomes a prompt. The prompt's default
value is the user's prior grant (on reinstall) or the manifest
declaration (on fresh install). The user hits Enter to confirm, or
edits. The only grants that *don't* prompt are those already supplied
via command-line flags (`--env`, `--file`, `--allow-net`,
`--allow-collection`) — a flag is the user's explicit input, so
re-prompting would be silly.

For list-shaped grants (`net`, `collections`), the prompt is a
multi-select over `prior ∪ manifest`. Entries new in the manifest
since last install are *not* pre-checked and carry a `(new)` hint, so
even a "check-all-and-Enter" user sees the diff. Entries the plugin
no longer requests but the user previously granted stay pre-checked
with `(plugin no longer requests)` — they can keep or uncheck.

`accepted()` / `accept()` helpers go away. `✓` only ever means "user
pressed Enter or typed."

## User Stories

1. As a user installing a new plugin, I want to see every host,
   collection, env value, schedule, and watch declaration the plugin
   wants — so nothing reaches my grants file behind my back.
2. As a user reinstalling a plugin I already configured, I want every
   prompt to default to my prior answers — so I can hold Enter and
   reuse my setup without re-typing tokens, paths, or schedules.
3. As a user reinstalling after a plugin update, I want any newly
   requested net host or collection pattern to appear *unchecked* in
   the consent prompt with a `(new)` label — so silent-widen across
   plugin updates is impossible.
4. As a user installing a plugin via flags (`--allow-net api.x.com`),
   I want the flag value to be used verbatim with no prompt — flags
   already are my explicit input.
5. As a script/CI user piping into `d plugin install` non-interactively,
   I want missing required env or files to fail loudly with
   `MissingInputsError` as today — no behavioral regression.
6. As a user, I want the `✓ <label>: <value>` lines in scrollback to
   only appear after I actually confirmed — never as auto-accept
   theatre.
7. As a user typing my Slack cookie or API token, I don't want a prior
   secret echoed somewhere I didn't expect; the existing `clip()`
   truncation in the `✓` recap and the prompt-echo behaviour is the
   bound we live with.
8. As a user toggling off every net host or every collection pattern
   in the multi-select, I want the install to proceed and the plugin
   to fail at runtime if it tries to use what wasn't granted — no
   install-time prediction.
9. As a user whose prior grant included a host the plugin now no
   longer asks for, I want to see it in the prompt pre-checked with a
   `(plugin no longer requests)` hint — so I can prune it or keep it
   for a downgrade.
10. As a user reinstalling with no manifest changes, I want to walk
    through each prompt with Enter — fast, but still explicit, because
    consent is cheap when the answer is reuse-as-is.

## Implementation Decisions

- **Single mechanism.** Every grant type prompts. No silent path.
  `accepted()` in `prompt.ts` and `accept()` in
  `plugin-install-interactive.ts` are deleted. `clip()` keeps living
  for the `confirm()` recap on long values.
- **Default precedence.** For each grant: `flag-value ?? prior-grant
  ?? manifest-declared`. If a flag supplied the value, the prompt is
  skipped entirely and the flag value is written verbatim.
- **List grants (net, collections).** Multi-select over
  `prior ∪ manifest`. Pre-check rule:
  - Fresh install (no prior grants): every manifest entry pre-checked.
  - Reinstall: entries the user previously granted stay pre-checked.
  - Manifest-only entries (new since last install): not pre-checked,
    `(new)` hint.
  - Prior-only entries (plugin no longer requests): pre-checked,
    `(plugin no longer requests)` hint.
  - Validation: collection patterns run through `validateGrantPattern`
    before the install proceeds; net hosts get the existing parsing.
  - Empty selection is allowed; runtime sandbox surfaces the
    consequence.
- **Env grants.** `promptText` with `default: prior ?? manifest.default`.
  Existing inline hint (`KEY (ENTER for <value>)`) shows the default
  verbatim — the whole point of "prior as default" is the user can
  reuse it via Enter. Existing global-env literal-vs-ref select kicks
  in only when a global value is present (unchanged).
- **File grants.** `promptText` with `default: prior ?? manifest.default`.
  Same as today, just with prior layered in.
- **Schedule / watch.** Existing prompts; default selection is the
  prior choice when one exists, otherwise the manifest declaration.
  No manifest-change callout — the prompt is the user's chance to
  adjust.
- **No deep `consent-state.ts` module.** The decision logic
  (pre-check rules, hint labels, default precedence) stays inline in
  `plugin-install-interactive.ts` next to the prompts it drives.
  Smaller surface to maintain; the rules are short and fit beside the
  prompt calls.
- **Flag bypass is whole-grant, not per-entry.** Passing
  `--allow-net api.x.com` skips the net prompt entirely and writes
  exactly `["api.x.com"]`. It does not pre-fill a multi-select with
  `api.x.com` pre-checked — flags are "I already decided."
- **No "proceed?" final confirm.** Each grant's `✓` line is the
  consent record; an extra final Y/n is redundant and was removed for
  good reason earlier.
- **Orphan grants impossible.** `d plugin remove` already wipes
  `grants/<name>.json`, so remove + reinstall behaves like a fresh
  install.
- **Schema unchanged.** Manifest, grants file, and `PluginInput` shape
  stay as they are.

## Testing Decisions

- **Unit tests** on the small inline helpers that compute multi-select
  state: input `{ prior, manifest }` → expected option list with
  checked + hint per entry. Table-driven, mirrors `relative-time.test.ts`
  and `table.test.ts` style. Cover: fresh install, identical
  reinstall, manifest-only addition (the `(new)` case), prior-only
  leftover (the `(no longer requests)` case), and the
  intersection-empty case.
- **No mocks for consola prompts.** Existing `plugin-install.test.ts`
  pattern uses TTY-off so prompts are skipped; keep that model.
  Behavior we care about is the *content* of the prompt option list,
  not the consola render.
- **End-to-end coverage** through `plugin-install.test.ts`: a
  non-interactive install with `--allow-net` / `--allow-collection`
  flags still produces a correct grants file; reinstall preserves the
  user's prior choices when manifest is unchanged.
- **No new test file required** unless the inline helper grows enough
  to warrant one — keep the test next to whatever it tests.

## Out of Scope

- Manifest-side `required: true` on individual net hosts or
  collections. Today the manifest can't distinguish "we need
  api.example.com or the plugin is useless" from "we'd like to fetch
  optional metadata from this CDN." Until that lands, install-time
  empty-selection guards would be speculative.
- Plugin code-identity surfacing (hashing `plugin.ts`, showing the
  install path) — useful but a separate spec.
- Diffing two `~/.dither/grants/<name>.json` snapshots from a CLI
  command. The diff that matters is shown live during the consent
  prompt; persisting it is yyy.
- Migration of existing grants files. Format is unchanged; no
  migration needed.
- Logging plugin sandbox violations to surface back at next install
  time. Useful, separate spec.
- Replacing consola with a different prompt lib. Out of scope; was
  flagged in `notes/plugin-install-tui.md` for a later, broader pass.

## Further Notes

- The audit that surfaced the silent-widen bug and the
  `accepted()`-vs-`confirm()` glyph collision is in the session
  transcript that produced this spec (commit history around
  `83fee04`).
- The friendlier custom-schedule prompt (commit `00a862a`) already
  routes schedule selection through `promptSelect`; this spec extends
  the same "prior-as-default" pattern to it.
- The "less code is better" pressure throughout: net + collections
  prompts replace `accept()/accepted()` 1:1 in lines of code;
  multi-select state is computed inline (no new module).
