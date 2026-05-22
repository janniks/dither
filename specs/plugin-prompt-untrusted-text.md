---
status: ready
priority: P2
---

# Plugin-supplied prompt text — untrusted display in interactive flows

## Problem Statement

When `dither plugin install` (or `plugin run` on a missing-input path)
drops into the interactive TUI, the per-field prompt today splices
manifest-supplied `description` text directly into the question line:

    Env OPENAI_API_KEY — Your OpenAI API key.

That description comes from a third-party `package.json` and is
untrusted. As written it has three problems:

1. **No visual boundary.** The user can't tell where Dither's voice ends
   and the plugin's voice begins. A malicious or sloppy manifest can
   make its blurb read like a CLI instruction (`"press Y to grant root
   access"`).
2. **No sanitization.** ANSI escapes, OSC 8 terminal hyperlinks, raw
   CRs, and control characters pass through to the user's terminal.
   That's a small but real injection surface (cursor moves, line
   overwrites, fake "✓" frames).
3. **Only env has a description channel.** Files have an optional
   `name`, no description. The plugin as a whole has no channel to
   explain what it does / why it wants the capabilities it asks for
   — only `display_name` and `tagline`, both severely length-capped.

We want manifest authors to be able to explain *what* each input is
for — and we want the user to always know that explanation is the
plugin talking, not Dither.

## Solution

A small "untrusted text" rendering primitive plus a manifest schema
extension.

**Render.** When showing plugin-supplied prose in the TUI, the CLI
draws a labelled box above the prompt:

    ┌─ from plugin ───────────────────────────────────────────────┐
    │ Your OpenAI API key. Used to call the chat-completion API.  │
    └─────────────────────────────────────────────────────────────┘
    Env OPENAI_API_KEY  ›

The box header (`from plugin`) is in Dither's voice (constant string,
dim). The contents are the plugin's voice (sanitized, word-wrapped,
default color). The prompt line below it is Dither's voice again.
Order is: box → blank line → question, so the user reads the
attribution before they read the claim.

**Sanitize.** Plugin text is run through a single pure helper before
display:

- strip all ANSI CSI / OSC sequences (including OSC 8 hyperlinks),
- replace control characters except `\n` with `?`,
- normalize `\r\n` and bare `\r` to `\n`,
- collapse runs of blank lines to one,
- hard-cap at 500 chars (truncate, trailing `…`),
- word-wrap to terminal width minus box chrome.

**Extend the schema.** Add an optional `description` to file defs.
Surface the existing `package.json` top-level `description` (already
present in most plugins as the standard npm field) in the same
"from plugin" box at the top of the interactive flow — the
plugin-wide explainer that env/file/net/collection descriptions can
defer to. Net and collections stay bare-string arrays; if a plugin
needs to explain *why* it wants a host or pattern, it does so in the
top-level description.

## User Stories

1. As a user installing a plugin, I want each required env var to come
   with the plugin's own explanation, so I know what I'm pasting before
   I paste it.
2. As a user, I want plugin explanations visually contained in a box
   labelled "from plugin", so I never confuse them with Dither's own
   instructions.
3. As a user, I want plugin descriptions to be safely rendered even if
   the plugin tries to inject ANSI escapes, cursor moves, or fake
   prompts, so a hostile manifest can't spoof Dither's UI.
4. As a user, I want plugin descriptions truncated to a reasonable
   length, so a multi-kilobyte description can't push the actual
   prompt off-screen.
5. As a user picking a file the plugin wants, I want to read the
   plugin's description of what the file is used for, so I don't grant
   read access to a private folder by accident.
6. As a user starting an install or first-time run, I want the
   plugin's overall description shown in a "from plugin" box at the
   top, so I have full context before any field-level prompts.
7. As a manifest author, I want to use the standard npm
   `description` field for the plugin-wide explainer, so I don't
   need a Dither-specific field for prose that npm already has a
   home for.
10. As a CLI maintainer, I want all manifest-supplied prose to flow
    through a single render helper, so I can audit the trust boundary
    by grepping for one call site.
11. As a CLI maintainer, I want the sanitizer to be a pure function
    against text-in / text-out fixtures, so its behavior under hostile
    inputs is unit-testable without TTY plumbing.
12. As a user on a narrow terminal (≤ 60 cols), I want the box to wrap
    the description to fit, so the box never breaks the layout.

## Implementation Decisions

### Schema extensions

- `FileDef` gains optional `description: string`.
- `ParsedPackage` exposes the standard npm `description` field from
  the top of `package.json` (untouched by the `dither:` schema).
- `EnvDef.description` already exists; unchanged.
- `net` and `collections` stay bare-string arrays. If a plugin needs
  to explain a host/pattern, it does so in the top-level description.
  Per-entry descriptions were considered and rejected as too much
  schema for too little payoff.
- No description on watch / schedule / display_name — those aren't
  prompted on.

### The render primitive

A new helper in `prompt.ts`:

    pluginText(text: string): void

Draws the labelled box to stdout. Internally splits responsibility:

- `sanitizePluginText(raw: string): string` — pure. Strip ANSI/OSC,
  scrub control chars, normalize newlines, collapse blank lines,
  hard-cap length.
- `wrapPluginText(safe: string, width: number): string[]` — pure.
  Word-wrap to a target inner width, returning an array of lines.
- `pluginText(raw: string)` — composes the two, draws the top rule,
  middle lines, bottom rule using box-drawing chars. Header literal
  is `from plugin`. Picocolors `dim` on the box chrome; description
  body in default color.

Width source: `process.stdout.columns ?? 80`, clamped to
`[40, 100]`. Box chrome (`│ ` + ` │` + colors) takes 4 cols.

Empty / whitespace-only descriptions render nothing (no empty box).

### Prompt-flow integration

In `plugin-install-interactive.ts`'s `promptInteractive`:

- Right after `printHeader(parsed)`: `pluginText(parsed.description)`
  if non-empty. This is the plugin-wide explainer box.
- Before each per-field env prompt: `pluginText(def.description)` if
  present, then the existing literal-vs-ref select. The description
  is no longer spliced into the prompt message — the question line
  goes back to `Env OPENAI_API_KEY`.
- Before each per-field file prompt: same wiring.
- Net / collections multi-selects: unchanged. No preamble box.
  If a plugin needs to explain its asks, it does so in the
  top-level description box that already preceded the field prompts.

`stepStart`/`stepDone` etc. unchanged — `pluginText` is its own
primitive, not a status line.

### Trust boundary

Every render of manifest-supplied prose goes through `pluginText`.
The audit rule: in `packages/cli/`, no other code may read
`manifest.*.description` and write it directly to stdout. The
existing `printHeader` that prints `display_name@version` is the
single exception (already restricted to a 60-char single line, no
freeform prose).

### Modules touched

- `manifest.ts` — `FileDef.description`; capture top-level npm
  `description` into `ParsedPackage`.
- `prompt.ts` — `pluginText` entry point.
- `untrusted-text.ts` (new) — pure `sanitizePluginText` and
  `wrapPluginText`. Deep module: the entire injection-defense surface
  lives behind two functions with text-in / text-out signatures.
- `plugin-install-interactive.ts` — call sites for the top-level
  description, env, and file prompts. Drop the inline
  `— ${def.description}` splice.

## Testing Decisions

External behavior of the pure helpers only — no consola plumbing.

- **`sanitizePluginText`** — table-driven, hostile-input fixtures:
  ANSI CSI (`\x1b[2J`, `\x1b[31m`), OSC 8 hyperlinks
  (`\x1b]8;;url\x1b\\label\x1b]8;;\x1b\\`), bare `\r`, mixed
  `\r\n`, null bytes, runs of blank lines, oversize input (truncate
  + `…`). Each row: raw input → expected sanitized output.
- **`wrapPluginText`** — width matrix (40, 60, 80, 100), long words
  longer than the width (force-break), pre-existing newlines
  respected as hard breaks.
- **Schema** — `parsePackage` captures top-level `description`,
  omits it when absent, ignores non-string values defensively;
  `FileDef.description` is optional.
- **Prompt flow** — not unit-tested at the consola level (consistent
  with existing decision in `plugin-install-interactive.md`: TTY
  interactive path is a thin pass-through). One smoke test
  asserting that `pluginText` is invoked when a description is
  present, via spying on `process.stdout.write` like
  `init.test.ts → captureLogs`.

Prior art: `init.test.ts` `captureLogs` pattern;
`manifest.test.ts` style for schema cases.

## Out of Scope

- Per-entry descriptions on `net` / `collections`. Considered and
  rejected during implementation: too much schema for too little
  payoff; the top-level description carries plugin-wide context.
- A markdown subset inside descriptions (bold, links, lists). Plain
  text only — explicitly out of scope.
- Internationalization / locale-aware wrapping (CJK width). v1
  uses string `.length` for width accounting.
- Showing the description after install in `dither plugin show` or
  similar. The render primitive will be reusable but no new
  command is added in this spec.
- Rich `from <plugin display_name>` labelling. The header is the
  constant string `from plugin`; resisting per-plugin styling keeps
  the chrome unspoofable.
- Locking down `display_name` / `tagline` / `icon` beyond today's
  60-char header cap.
- Sanitization of CLI-flag values the user types themselves. The
  trust boundary is the manifest, not the user.

## Further Notes

- The header literal `from plugin` is deliberately lowercase and
  short so the box reads as a quote attribution, not a section
  heading.
- The 500-char cap is a heuristic, not a hard ceiling — adjustable
  later. Truncation appends `…` and a final dim
  `(description truncated)` line inside the box.
- `pluginText`'s output stays in scrollback like every other CLI
  line; it's not a rewrite-zone. That matters for
  audit-after-the-fact: the user can scroll up and re-read what the
  plugin said.
- Sanitization preserves visible UTF-8 (emoji, accented chars, box
  drawing characters in the *content*). The boundary is control
  chars and escape sequences, not printable Unicode. A plugin
  drawing its own box inside the description is allowed; it just
  reads as ASCII art inside the labelled box, not as a fake CLI
  frame.
- Existing `plugin-install-interactive.md` covers the broader
  install flow. This spec layers on top: it changes *how* prose is
  shown, not *what* is shown or *when*.
