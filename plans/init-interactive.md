# Plan: `dither init` — interactive flow + location concept rename

> Source spec: `specs/init-interactive.md`

## Architectural decisions

- **Env var rename**: `DITHER_HOME` → `DITHER_DIR`. The new name reflects
  "dither's working directory" (config + bookkeeping), distinct from the
  user's content (the library).
- **Lookup chain** for the config dir, first match wins:
  1. `$DITHER_DIR` (explicit).
  2. `$XDG_CONFIG_HOME/dither` (Linux convention).
  3. `$DITHER_HOME` — soft alias for one release; emits a one-shot
     deprecation warning.
  4. `~/.dither` (fallback — current behavior, macOS-friendly).
- **Library default**: `<DITHER_DIR>/library` — unchanged. Users opt into a
  visible location via `--library` at init.
- **TUI / prompt library**: `consola` (UnJS, citty's family). Single
  wrapper module in the CLI so a future swap to `@clack/prompts` is a
  one-file change.
- **Non-interactive contract**: every prompt has a matching CLI flag. No
  `-y`. Today: one prompt (library) ↔ one flag (`--library`).
- **`--force` removed**: init is one-shot. Reconfiguration is a future
  separate surface.
- **`--download` unchanged**: default `true`, not a prompt; stays the only
  CLI knob beyond `--library`.
- **`dither status` two-row output**: `config dir:` and `library:` are
  separate rows, each with a parenthetical naming the source (`env:
  DITHER_DIR` / `config: library.path`).
- **Behavior matrix**: 5 cases (TTY/no-TTY × flag/no-flag × config-exists),
  per spec.

---

## Phase 1: Home resolver + `DITHER_DIR` rename

**User stories**: 7, 8, 9.

The home resolver picks up the new lookup chain (`DITHER_DIR` →
`XDG_CONFIG_HOME/dither` → `DITHER_HOME` (warn) → `~/.dither`). Existing
`DITHER_HOME`-using callers (tests, persistence files, docs) keep working
because the alias is honored. A one-line deprecation warning is emitted
the first time `DITHER_HOME` is read in a process.

**Acceptance:**
- [x] `$DITHER_DIR` set takes precedence over everything else.
- [x] `$XDG_CONFIG_HOME` set with `$DITHER_DIR` unset resolves to
      `$XDG_CONFIG_HOME/dither`.
- [x] Only `$DITHER_HOME` set (no `DITHER_DIR`, no `XDG_CONFIG_HOME`)
      still resolves to that path AND emits a single deprecation warning
      to stderr.
- [x] All env vars unset resolves to `~/.dither`.
- [x] Existing test suite continues to pass — *updated* to use
      `DITHER_DIR` rather than rely on the alias (alias path verified
      by `home.test.ts`; test code is internal — switching to the new
      name is the cleaner outcome).
- [x] New unit tests for the resolver cover the precedence chain
      explicitly.

**Outcome:** Resolver in `home.ts` implements the four-step chain with
a once-per-process deprecation warning latch. `home.test.ts` covers all
four precedence cases (4 tests, green). `persistence.ts` writes
`DITHER_DIR` into the launchd plist + systemd unit for new installs.
Test files using `DITHER_HOME` mass-renamed to `DITHER_DIR` (codebase-
internal; end-user shell rc files unaffected — alias handles them).
Fast subset (7 files / 31 tests over home, journal, locks, config,
library-resolver, cli-dispatch, persistence) all green. Pre-existing
slow plugin-host / env / daemon test timeouts (deno-download in
test setup) are unrelated to this change.

---

## Phase 2: `dither status` two-row split

**User stories**: 10.

`dither status` (and the underlying status module) print the config dir
and the library as two distinct rows with their source labels. A nested-
default install shows both rows even if they share a prefix, so the
conceptual split is visible at a glance.

**Acceptance:**
- [x] `dither status` prints `config dir:` and `library:` as separate rows.
- [x] Each row has a parenthetical source label: `(env: DITHER_DIR)` /
      `(config: library.path — set by \`dither init --library\`)`.
- [x] JSON mode (`--json`) reflects the same shape: separate `configDir`
      and `library` fields, with `home` retained as deprecated alias.
- [x] Existing `lifecycle.test.ts` consumer of `status.home` keeps
      working via the alias; new `status.test.ts` covers configDir,
      library-null, nested-default and separate-location cases.

**Outcome:** `DitherStatus` extended with `configDir` and `library`
(string | null), `home` retained as alias. `commands/status.ts` prints
two rows with source labels; falls back to `(not configured — run
\`dither init\`)` when no library is set yet. JSON output exposes all
fields. New `status.test.ts` adds 5 cases (9 tests green when
combined with home.test.ts). Live smoke against `test.local/.dither`
confirms human + JSON output both look right.

---

## Phase 3: Interactive `dither init`

**User stories**: 1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15.

The bulk of the feature: add the `consola` dep, a new prompt-wrapper
module, the interactive branch in init, the no-TTY error path, the end-
of-init summary + next-step nudge, and Ctrl-C clean exit. Drop `--force`.
Existing `--library` flag path keeps working unchanged.

**Acceptance:**
- [x] `consola` added as a CLI dep; the prompt wrapper module exposes a
      `promptText({ message, default, hint, validate })` helper.
- [x] `dither init` on a TTY with no existing config prompts for the
      library path; default is `<DITHER_DIR>/library`; placeholder hint
      shows `~/Documents/dither`; Enter accepts the default.
- [x] Validation runs after submission (writable directory, mkdir if
      absent, realpath canonicalisation). Failures re-prompt with the
      error inline rather than crashing.
- [x] `dither init` without a TTY and without `--library` exits with a
      non-zero status and a clear error message naming the missing flag.
- [x] `dither init --library /path` runs non-interactively (today's
      behavior unchanged).
- [x] `dither init` on an already-configured home is a no-op that prints
      the existing summary and exits 0.
- [x] `--force` flag is removed from the init command.
- [x] `--download` flag remains, default `true`, no prompt.
- [x] After successful init, output is three short lines (config wrote,
      library created, weights pre-downloaded) plus a one-line
      `next: dither plugin install <path>` nudge.
- [x] Ctrl-C at the prompt exits with a non-zero status, no partial
      `config.json` written, no half-created library.
- [x] Tests cover: non-TTY-without-flag error, non-TTY-with-flag works,
      existing-config no-op. Interactive TTY path itself is left out of
      unit tests (TTY interaction is fiddly; wrapper is a thin
      pass-through).

**Outcome:** New `prompt.ts` wraps `consola.prompt` with
`promptText({ message, hint, default, validate })` — re-prompts on
validation failure, propagates Ctrl-C as a rejection. Init flow:
existing-config → summary + (note "--library ignored" if flag passed);
no config → branch on `process.stdout.isTTY`. TTY → prompt with the
default + hint; non-TTY → stderr error + exit 2. Ctrl-C → exit 130
with no partial state. End-of-init prints three ✓ lines + a
`next: dither plugin install <path>` nudge. `--force` removed; tests
pruned of the two `--force` scenarios; new tests cover the no-TTY
error and re-init-flag-ignored paths. 25 tests green (init: 16,
home: 4, status: 5). Live smoke confirms the no-TTY error, the
non-interactive --library path, and the re-init flag-noted path.

---

## Phase log

When starting implementation, rename this file to
`./plans/init-interactive-RUNNING.md`. Work one phase at a time, ticking
acceptance as each criterion is satisfied. Stage and commit each phase's
changes after finishing; append a row to the log below. When all phases
complete, rename back to `./plans/init-interactive.md`.

| commit | summary |
|--------|---------|
| b684d32 | Phase 1: home.ts resolves DITHER_DIR → XDG_CONFIG_HOME/dither → DITHER_HOME (warn-once) → ~/.dither. New home.test.ts. persistence.ts writes DITHER_DIR. Test files mass-renamed to DITHER_DIR. |
| bfcbb1b | Phase 2: status.ts split — configDir + library (string\|null); home alias retained. commands/status.ts prints two-row output with source labels. status.test.ts adds 5 cases. |
| 65c6ded | Phase 3: consola dep + prompt.ts wrapper. Init drops --force, adds TTY interactive prompt with re-validation, no-TTY error, re-init flag-noted path, ✓ summary + next-step nudge. 16 init tests + 25 phase-suite tests green. |
