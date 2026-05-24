# Plan: plugin install consent

> Source spec: `specs/plugin-install-consent.md`

## Architectural decisions

- **No new module.** Decision logic (pre-check rules, hint labels,
  default precedence) stays inline in
  `packages/cli/src/plugin-install-interactive.ts` next to the prompts
  it drives. Small inline helpers may be extracted as private
  functions purely for testability.
- **Default precedence everywhere:** `flag-value ?? prior-grant ??
  manifest-declared`. If a flag supplied the value, the prompt is
  skipped and the flag value is written verbatim.
- **Multi-select state rule:**
  - option list = `prior ∪ manifest` (preserves order: manifest first,
    then prior-only entries appended)
  - pre-checked if entry ∈ prior OR (no prior grants exist AND entry ∈
    manifest)
  - hint `(new)` when entry ∈ manifest AND prior grants exist AND
    entry ∉ prior
  - hint `(plugin no longer requests)` when entry ∈ prior AND
    entry ∉ manifest
- **Deletions:** `accept()` in `plugin-install-interactive.ts`,
  `accepted()` in `prompt.ts`. `clip()` stays — still used by
  `confirm()`.
- **Schema unchanged.** No manifest, grants, or input-shape change.

---

## Phase 1: net + collections multi-select with diff-aware pre-check

**User stories**: 1, 3, 6, 9 from spec.

Replace `accept("net")` and `accept("collections")` with
`promptMultiSelect` calls. Compute options + pre-check + hints inline
per the architectural rule above. Skip prompt entirely when a flag
supplied the value. Empty selection allowed (no install-time gate).

**Acceptance:**
- [ ] `net` and `collections` go through `promptMultiSelect` on TTY
- [ ] Fresh install: every manifest entry pre-checked, no hints
- [ ] Reinstall, unchanged manifest: prior entries pre-checked, no hints
- [ ] Reinstall + manifest added a host: new entry unchecked, `(new)` hint
- [ ] Reinstall + manifest removed a host: prior entry pre-checked,
      `(plugin no longer requests)` hint
- [ ] `--allow-net api.x.com` writes `["api.x.com"]` with no prompt
- [ ] `--allow-collection slack/**` writes `["slack/**"]` with no prompt
- [ ] Empty selection accepted; grants file gets `net: []` /
      `collections: []`
- [ ] `validateGrantPattern` still rejects bad collection patterns
      before the install proceeds
- [ ] `accept()` helper deleted from `plugin-install-interactive.ts`
- [ ] Inline option-builder helper has unit tests (table-driven, like
      `relative-time.test.ts`)

---

## Phase 2: env + file prior-as-default

**User stories**: 1, 2, 6.

Layer prior grant values under manifest defaults for env and file
prompts. Currently `planInstall` treats env-with-default as already
satisfied and skips it from `missing`; we need env with manifest
default to *always* prompt (unless flag-supplied), with the default
pre-filled.

**Acceptance:**
- [ ] Env with manifest default now prompts; default = `prior ??
      manifest.default`
- [ ] Env with prior value uses prior as the prompt default
- [ ] File grants use `prior ?? manifest.default` as prompt default
      (today they only use `manifest.default`)
- [ ] `--env KEY=value` skips the env prompt for that key
- [ ] `--file id=path` skips the file prompt for that id
- [ ] Required env without default still prompts as today (no
      regression)
- [ ] `plugin-install.test.ts` non-interactive paths still pass

---

## Phase 3: schedule + watch prior defaults + cleanup

**User stories**: 1, 2.

`promptScheduleConsent` and `promptWatchConsent` initial selection
becomes the prior choice when one exists; falls back to the manifest
declaration as today. Delete `accepted()` from `prompt.ts`. Leave
`clip()` in place (still used by `confirm()`).

**Acceptance:**
- [ ] Schedule prompt initial highlight = prior schedule on reinstall
- [ ] Watch prompt initial highlight = prior watch on reinstall
- [ ] `accepted()` deleted from `prompt.ts`
- [ ] No remaining importers of `accepted` (grep clean)
- [ ] All existing `plugin-install.test.ts` cases pass

---

## Phase log

When starting implementation, rename this file to `./plans/<feature>-RUNNING.md` (signals work in progress so another agent can pick up if interrupted). Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. If git is available, stage and commit only that phase's changes after finishing, then continue to the next phase on your own. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/<feature>.md`.

| commit | summary |
|--|--|
|  |  |
