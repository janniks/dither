# Plan: plugin install — interactive flow

> Source spec: `specs/plugin-install-interactive.md`

## Architectural decisions

- **Entry point**: `installPluginOrExit` at the CLI command boundary is the
  single interactive surface. `installPlugin()` in `plugin-install.ts` stays
  I/O-free.
- **Deep module**: `planInstall(manifest, existingGrants, flags) → PromptPlan`
  is the pure decision core. The prompt driver is a thin walker over the plan.
- **Prompt grammar**: extend `prompt.ts` with `promptSelect` and
  `promptMultiSelect`. Same wrapper-over-consola pattern as `promptText`.
- **Non-TTY**: collect every missing required field, exit 1 with a single
  enumerated error. No `--non-interactive` / `--yes` flag.
- **Reinstall**: pre-fill prompts from existing `grants/<name>.json`. CLI
  flags win over pre-fills. Brand-new manifest fields show unprefilled.
- **Cross-references**: install and run `meta.description` mention each
  other. Both end with one `next:` line; install adds a schedule preview
  when the manifest declares `schedule`.

---

## Phase 1: Pure planner + all-missing error

**User stories**: 8, 9, 17

Introduce the pure planner and switch the install code to collect every
missing required field before failing. CI users get one error listing all
missing fields; the planner ships untested-from-UI but unit-tested.

**Acceptance:**
- [x] `planInstall(manifest, existingGrants, flags) → PromptPlan` exists,
      pure, exported.
- [x] `resolveEnv` / `resolveFiles` gain a collect-mode used by the planner;
      throw-on-first remains the default.
- [x] Non-TTY `dither plugin install <path>` with multiple missing required
      fields exits 1 with one enumerated error.
- [x] Existing non-TTY success path unchanged (today's scripted installs
      keep passing).
- [x] Planner unit tests cover: missing required env; missing required
      file; both-missing; all satisfied.

---

## Phase 2: Interactive env + file prompts

**User stories**: 1, 13, 15, 16

Wire the planner's missing-fields output to a TTY prompt loop. Per-env
select (`Use default / Enter literal / Read from dither env / Skip`),
per-file text prompt. Net/collections continue to take manifest defaults
in this phase.

**Acceptance:**
- [x] `prompt.ts` exports `promptSelect`.
- [x] On a TTY, missing required env triggers a select; literal entry
      drills into a text prompt.
- [x] On a TTY, missing required file triggers a text prompt validated
      by `resolveFiles` rules.
- [x] Ctrl-C mid-prompt exits 130 with no grants written, no plugin code
      copied.
- [x] `plugin run <path>` benefits from the same prompts (no duplication).

---

## Phase 3: Net + collections review

**User stories**: 3, 4, 5

Promote net and collections from silent manifest pass-through to explicit
review. Multi-select with pre-checked manifest entries and a `+ Add
custom…` row. Custom collection patterns validated inline.

**Acceptance:**
- [x] `prompt.ts` exports `promptMultiSelect` (pre-check + add-custom +
      validator hook).
- [x] Net hosts shown as multi-select on every interactive install.
- [x] Collections shown as multi-select with `validateGrantPattern` on
      any custom entry; re-prompts on invalid pattern.
- [x] Add-custom uses the spec Q4 fallback: multi-select then text-prompt
      loop (blank to stop). consola has no inline "+ Add row" affordance.

---

## Phase 4: Pre-fill from existing grants

**User stories**: 6, 7

Planner reads existing `grants/<name>.json` and pre-fills prompt defaults
per field. New manifest fields show unprefilled. CLI flags still win.

**Acceptance:**
- [ ] Reinstall of an existing plugin pre-fills env literals, allow-refs,
      file paths, granted net hosts, and granted collections.
- [ ] A new env added in the manifest since the last install appears in
      the prompt flow with no pre-fill.
- [ ] CLI flag values override grants pre-fills.
- [ ] Pre-fill matrix tests against `planInstall`.

---

## Phase 5: Header, Proceed?, next-line polish

**User stories**: 2, 10, 11, 12, 14

Add the title header at the top of interactive mode, the final
`Proceed? [Y/n]` confirm, the end-of-install `next:` line with schedule
preview, and the install/run cross-references in `meta.description`.

**Acceptance:**
- [ ] Interactive install prints `<icon> <display_name>@<version>` at top,
      truncated to ~60 chars. Non-interactive output unchanged.
- [ ] After all prompts answered, `Proceed? [Y/n]` blocks the write; N
      aborts cleanly.
- [ ] End-of-install prints one `next:` line. `schedule:` plugins include
      a `next run: <relative> (<absolute>)` line above it. `watch:`
      plugins are told they run automatically.
- [ ] `plugin run <path>` ends with `note: grants persisted. future runs:
      'dither plugin run <name>'.`.
- [ ] `installSubcommand.meta.description` mentions `plugin run` and
      vice versa.

---

## Phase log

| commit | summary |
|--|--|
| e359133 | phase 1 — pure planner, `MissingInputsError` enumerates all missing required fields, `installPluginOrExit` exits 1 cleanly. 13 unit tests. |
| f0a5450 | phase 2 — interactive env + file prompts on TTY via `promptSelect`/`promptText`; `mergeInputs` overlays prompt answers on flag inputs; Ctrl-C aborts with exit 130. Non-TTY path verified manually with `read-file` fixture. |
| _pending_ | phase 3 — net + collections review via `promptMultiSelect`; pre-checked from flag-or-manifest; add-custom loop with `validateGrantPattern` on collection entries (spec Q4 fallback — blank line ends add loop). `promptMissing` renamed to `promptInteractive` to reflect always-runs-on-TTY scope. |
