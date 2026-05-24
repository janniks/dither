# Plan: plugin-install-ux

> Source spec: `specs/plugin-install-ux.md`

## Architectural decisions

- **Grants schema**: gain top-level `schedule: string | null` (user's effective cron, `null` = manual-only) and top-level `watch: { collections; glob? } | null`. `manifest.schedule` / `manifest.watch` remain in grants as declared (for debug); daemon ignores them. **Clean break — no migration.** Grants without the new fields are treated as manual / watch-disabled.
- **Manifest schema**: `FileDef.default_hint` removed. Single `default` attribute drives the auto-derived `(ENTER for <default>)` hint at prompt time.
- **Consent rule**: install never enrolls the user in recurring background work without an explicit prompt answer. `ensureDaemonForPlugin` and the `next run:` install hint both gate on consented state, not on manifest declaration.
- **Voice separation**: plugin prose stays inside `from plugin` boxes (`pluginText`). Dither's own advisories use a new `ditherText` helper with distinct chrome. Audit rule unchanged: nothing else writes raw `manifest.*.description` to stdout.

---

## Phase 1: Visual polish — drop `default_hint`, surface defaults, dedupe description boxes

**User stories**: 4, 6, 9

Slice delivers: re-running `d plugin install plugins/imessage` no longer shows two stacked "from plugin" boxes back-to-back, and the `MESSAGES_DIR` prompt now ends with `(ENTER for ~/Library/Messages)` — without consent or daemon changes yet.

**Acceptance:**
- [x] `FileDef` schema in the plugin manifest no longer accepts `default_hint`; any consumer is updated.
- [x] `promptText` appends `(ENTER for <default>)` to the message line when a `default` is provided and the caller hasn't already baked the hint into `message`.
- [x] Top-level package-description "from plugin" box is suppressed when at least one `manifest.env` / `manifest.files` entry has a non-empty `description`.
- [x] iMessage manifest in the user's sandbox gains `default: "~/Library/Messages"` on `MESSAGES_DIR`.
- [x] Slack fixture's `default_hint` removed.
- [x] Existing install/prompt tests pass; new focused tests cover the ENTER-hint derivation and the description-dedup rule.

---

## Phase 2: Schedule + watch consent + grants schema

**User stories**: 1, 2, 3, 7, 8

Slice delivers: installing iMessage prompts for schedule (`[As declared (every 15 minutes) | Manual only | Custom cron…]`) and watch (Y/n if declared). The user's choice is persisted to grants, the daemon honors it (Manual-only → no schedule entry, no `next run:` line, no daemon autostart), and `dither plugin list` reports the effective state.

**Acceptance:**
- [x] Grants file gains top-level `schedule` and `watch` fields populated from the consent answer; `manifest` block preserved verbatim.
- [x] `promptInteractive` includes a schedule-consent step (when manifest declares `schedule`) and a watch-consent step (when manifest declares `watch.collections`).
- [x] Choosing "Custom cron…" opens a text prompt validated via `parseSchedule`; re-prompts on invalid input.
- [x] Scheduler / daemon / `plugin-list` read from `grants.schedule` and `grants.watch`; ignore `manifest.schedule` / `manifest.watch`. Grants files lacking the new fields are treated as manual / disabled.
- [x] `ensureDaemonForPlugin` and the `next run:` install hint trigger only when the user actually consented.
- [x] Tests cover: three schedule paths (declared / manual / custom), two watch paths (Y / N), grants-write contents, daemon-skips-disabled-schedule.

---

## Phase 3: macOS FDA flow — styled note + open-Settings prompt

**User stories**: 5

Slice delivers: when a granted folder is TCC-protected, install ends with a single Dither-voice box (visually distinct from "from plugin") and a `[Y/n]` offer to open System Settings. Yes spawns the `x-apple.systempreferences:` URL via `openBrowser`; No leaves the URL visible in the note.

**Acceptance:**
- [x] New `ditherText` helper in the prompt module renders a Dither-voice box (different border color / label) distinct from `pluginText`.
- [x] `maybeWarnInstall` returns a structured `{ path, callerBinary, settingsUri } | null` instead of writing to `console.error`.
- [x] After successful install, the command layer renders the Dither-voice note when a protected path is reported and prompts `Open System Settings now to grant Full Disk Access? [Y/n]`. Yes → `openBrowser(FDA_SETTINGS_URI)`. Non-TTY callers skip the prompt and just print the note.
- [x] `tcc-hint.test.ts` updated to assert on the returned structure rather than stderr blob; new command-layer test covers the open-on-Yes / skip-on-No paths with an injected `openBrowser`.

---

## Phase log

When starting implementation, rename this file to `./plans/<feature>-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. If git is available, stage and commit only that phase's changes after finishing, then continue to the next phase on your own. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/<feature>.md`.

| commit | summary |
|--|--|
| 032f94d | phase 1: ENTER-for-default auto-hint, drop default_hint, dedupe top-level description box |
| 18574e2 | phase 2: schedule + watch consent prompts; grants gain top-level schedule/watch; daemon honors choice |
| a09487d | phase 3: dither-voice FDA note + interactive open-Settings prompt; tcc-hint returns structured info |
