# Plan: Plugin-supplied prompt text — untrusted display

> Source spec: `specs/plugin-prompt-untrusted-text.md`

## Architectural decisions

- **Trust boundary**: a single render primitive (`pluginText`) is the
  only call site that may print manifest-supplied prose to stdout.
  Audit rule: `manifest.*.description` may not be `console.log`'d or
  `process.stdout.write`n directly from anywhere else in
  `packages/cli/`. Existing `printHeader` (60-char `display_name`)
  is the lone exception.
- **Deep module**: sanitization + wrapping live in a new
  `untrusted-text` module with two pure functions
  (`sanitizePluginText`, `wrapPluginText`). Text-in / text-out, no
  TTY plumbing. This is where the injection-defense surface gets
  audited and unit-tested.
- **Schema**: `EnvDef.description` already exists.
  `FileDef.description` added. `net` and `collections` accept a
  union of `string | { value: string, description?: string }`;
  parser normalizes to the object form, the rest of the code only
  sees that form. Resolved/grant shapes (`string[]`) unchanged.
- **Header literal**: the box header is the constant string
  `from plugin` — lowercase, never includes the plugin's own
  display name (resists spoofing).
- **Width**: `process.stdout.columns ?? 80`, clamped to
  `[40, 100]`. Chrome (`│ ` + ` │`) takes 4 cols.
- **Length cap**: 500 chars; truncate with `…` and a trailing dim
  `(description truncated)` line inside the box.

---

## Phase 1: Sanitizer + wrapper deep module

**User stories**: 3, 4, 11, 12

Stand up `untrusted-text` with `sanitizePluginText` and
`wrapPluginText`. Pure text-in / text-out. No callers yet — the
demo is the test suite passing against hostile fixtures.

**Acceptance:**
- [x] `sanitizePluginText` strips ANSI CSI (`\x1b[...m`, `\x1b[2J`, etc.)
- [x] `sanitizePluginText` strips OSC 8 hyperlinks
      (`\x1b]8;;url\x1b\\label\x1b]8;;\x1b\\`)
- [x] `sanitizePluginText` normalizes `\r\n` and bare `\r` to `\n`
- [x] `sanitizePluginText` replaces other control chars (incl. NUL)
      with `?`, preserves UTF-8 printable (emoji, accented chars)
- [x] `sanitizePluginText` collapses runs of blank lines to one
- [x] `sanitizePluginText` truncates above 500 chars with `…` and
      flags truncation so callers can render the trailing note
- [x] `wrapPluginText` word-wraps to a target inner width
- [x] `wrapPluginText` respects existing newlines as hard breaks
- [x] `wrapPluginText` force-breaks words longer than the width
- [x] Width matrix tested at 40 / 60 / 80 / 100
- [x] Hostile-input fixtures: CSI, OSC, bare CR, mixed CRLF, NUL,
      blank-line runs, oversize input

---

## Phase 2: `pluginText` render primitive in `prompt.ts`

**User stories**: 2, 10

Wire the labelled box (`┌─ from plugin ─┐ … └─┘`) into `prompt.ts`
as `pluginText(raw: string): void`. Composes sanitizer + wrapper,
draws chrome in `pc.dim`, body in default color. Empty /
whitespace-only descriptions render nothing. Width derived from
`process.stdout.columns`.

No call sites in the install flow yet — phase 3 wires those.
Demoable via a one-line scratch script (or via the smoke test).

**Acceptance:**
- [x] `pluginText("hello")` writes a 3-line box: top rule with
      `from plugin` label, body `│ hello …│`, bottom rule
- [x] Box width derived from `process.stdout.columns`, clamped
      `[40, 100]`
- [x] Empty / whitespace-only input → no output (no empty box)
- [x] Hostile input (ANSI/OSC/CR/NUL) renders sanitized
- [x] Long input wraps inside the box, no overflow past the right
      edge
- [x] Truncated input shows trailing dim `(description truncated)`
      line inside the box
- [x] Smoke test captures stdout (spy on `process.stdout.write`,
      same pattern as `init.test.ts`) and asserts the chrome lines

---

## Phase 3: Wire env + file prompts; add `FileDef.description`

**User stories**: 1, 5, 8

Replace the inline `— ${def.description}` splice in
`plugin-install-interactive.ts` with a `pluginText(def.description)`
call before each env and file prompt. Schema gains
`FileDef.description`. Question line returns to clean form
(`Env OPENAI_API_KEY`, `Path for <label>`).

Existing planInstall tests stay green (planner doesn't touch
descriptions; resolved outputs unchanged).

**Acceptance:**
- [x] `FileDef` schema accepts optional `description: string`
- [x] env prompt: when manifest has `description`, `pluginText`
      called before the literal-vs-ref select; prompt message no
      longer contains the description text
- [x] env prompt: when manifest has no `description`, no box
      rendered, prompt looks the same as today minus the `—` tail
- [x] file prompt: same wiring; description box appears above the
      path prompt
- [x] All existing `plugin-install-interactive.test.ts` cases still
      pass
- [x] One new test asserts `pluginText` is invoked when description
      present (spy on stdout chrome line containing `from plugin`)

---

## Phase 4: Schema union for net / collections + preamble box

**User stories**: 6, 7, 8, 9

`net` and `collections` accept `string | { value, description? }`.
`parsePackage` normalizes to `{ value, description? }`. Planner /
grant code continues to see `string[]` via a `.value` extract.
`reviewList` in the install-interactive flow, when any entry in
its list has a description, renders a single preamble box listing
each entry on its own line followed by the description on an
indented line below it. The multi-select itself stays a single
prompt with bare values as options.

**Acceptance:**
- [x] `parsePackage` accepts bare-string `net` entries (legacy)
- [x] `parsePackage` accepts object-form `net` entries with /
      without description
- [x] `parsePackage` accepts mixed-array `net` (string + object)
- [x] Same three cases for `collections`
- [x] Normalized internal shape is `{ value, description? }[]`;
      `parsed.manifest.net[i]` always an object
- [x] `planInstall` resolves net/collections to `string[]`
      (unchanged behavior, existing tests green)
- [x] `reviewList` renders one preamble box when any entry has a
      description; box body lists each entry + its description;
      no box when no entry has a description
- [x] Multi-select options still display bare values (host /
      pattern), no description noise in the consola hint
- [x] Manifest schema parser tests cover the three input shapes

---

## Phase log

When starting implementation, rename this file to
`./plans/plugin-prompt-untrusted-text-RUNNING.md`. Work one phase
at a time, ticking acceptance criteria as satisfied. Stage + commit
only that phase's changes after finishing. Append a row to the log
after every phase. When all phases complete, rename back.

| commit | summary |
|--------|---------|
| a42d44f | Phase 1 — untrusted-text sanitize + wrap; 25 tests green |
| d9775a6 | Phase 2 — pluginText box renderer; 7 chrome tests green |
| 009f46a | Phase 3 — env+file prompts via pluginText; FileDef.description; 56 tests green |
| 5f5dbb6 | Phase 4 — net/collections schema union + preamble box; 63 tests green |
| a7b9a5e | Phase 5 — revert Phase 4; surface top-level pkg description via pluginText after printHeader; 59 tests green |
