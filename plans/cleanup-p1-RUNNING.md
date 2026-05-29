# Plan: cleanup-p1

> Source: `notes/p1-code-conventions-audit.md` (audit findings + graph analysis), `notes/p1-cleanup-todo.md` (deferred items), grilling session 2026-05-29.
> Referenced: `AGENTS.md`, `CONTEXT.md`, `docs/adr/0001-run-log-dual-scope.md`, `notes/ipc-landscape.html`, `notes/ipc-graph.html`.

## Architectural decisions

- **File-naming convention.** Three categories, each with a visible prefix signal:
  - `daemon-` prefix: daemon-layer files (`daemon.ts`, `daemon-jobs.ts`, `daemon-control.ts`, `daemon-client.ts`).
  - `command-` prefix: CLI command files (new — applied in Phase 7; covers everything under `commands/`).
  - Bare names: domain modules (`run-log`, `locks`, `kicks`, `inbox`, `refire`, `markers`, `promotion`, …).
- **IPC primitives — six file-based + one POSIX.** Lock, Kick, Refire, Inbox, Marker, Run-log + Signal. "Snapshot" is not a primitive — `status.json`, `env.json`, `config.json`, `history/`, `jobs/` are typed JSON state files at known paths.
- **Marker = the lazy form of Signal.** Signal = "wake up now" (POSIX). Marker = "next time you check, this state holds" (FS). They compose: write a marker + send a signal = "do this now AND remember it."
- **Refire = Kick with retry/schedule state.** Same family as Kick, distinct lifecycle.
- **Markers live at `<home>/markers/`.** One-time auto-migration from the old top-level paths on first run.
- **Status writes are event-driven; no heartbeat.** Liveness via pid file + `kill(pid, 0)` + token match. `status.json` includes `lastUpdated` for human inspection.
- **ENOENT idiom rule.** `try/catch (err.code === "ENOENT")` when the function IS the I/O boundary; `.catch(() => null)` when the caller is doing best-effort cleanup. Documented in AGENTS.md.
- **CONTEXT.md trimming.** Drop "Reconciler" (use plain "daemon's index loop"). Drop "Lock theme" (use "named lock" or describe `qmd-{download,index,embed}` directly).

## Constraints

- AGENTS.md style rules apply throughout (no `else`, no `let` where avoidable, no `any`, no unnecessary destructuring, single-word locals, time-typed names keep their unit suffix).
- Commit per phase; tests pass before each commit.
- Never rewrite git history.
- File is renamed back to `cleanup-p1.md` on completion.

---

## Phase 1: `promotion.ts` IIFE rewrite

**User stories:** code-reviewer reading `promotion.ts` for the first time doesn't get tripped up by a hostile expression.

Rewrite the 3-level nested ternary with embedded `(() => { throw … })()` IIFE at `promotion.ts:85-93` as an early-return helper. Behavior preserved.

**Acceptance:**
- [ ] `promotion.ts:85-93` block no longer contains an IIFE or 3+ nested ternaries
- [ ] All existing `promotion.test.ts` cases pass without modification
- [ ] `oxlint` / `tsc` clean

---

## Phase 2: Run-log `truncateGlobal()` Maps bug fix

**User stories:** the daemon-startup truncation correctly clears all module-level state.

`truncateGlobal()` currently clears `sizes` but not `queues` (audit finding). Add `queues.clear()`. Add a docstring noting the singleton state is deliberate and matches the `home.ts` precedent for a single-process-per-daemon CLI.

**Acceptance:**
- [ ] `truncateGlobal()` clears both `queues` and `sizes`
- [ ] Docstring on the module-level state explains the singleton-by-design rationale
- [ ] `run-log.test.ts` passes; a new or extended test asserts both maps clear

---

## Phase 3: ENOENT idiom rule documented

**User stories:** new contributor knows which ENOENT pattern to use without guessing.

Add an "I/O patterns" section (or extend "General principles") in `AGENTS.md` with the rule: `try/catch (err.code === "ENOENT")` when the function IS the I/O boundary; `.catch(() => null)` when the caller is doing best-effort cleanup. One short example of each.

**Acceptance:**
- [ ] `AGENTS.md` contains the rule + one example of each idiom
- [ ] Rule readable at 1/4 desktop width (AGENTS.md format constraint)
- [ ] No code change required (optional: fix one or two egregious mismatches as examples if any stand out)

---

## Phase 4: CONTEXT.md cleanup (snapshot reframe + marker-as-lazy-signal + strip invented terms)

**User stories:** new contributor reading CONTEXT.md learns vocabulary that matches the actual code, not made-up nouns.

Combined CONTEXT.md edit:
- Drop "Snapshot" as a primitive category — note these are typed JSON state files at known paths.
- Update **Marker** description: "the lazy form of Signal. Signal = wake up now; Marker = next time you check, this state holds. They compose."
- Add **Refire** note: "Kick with retry/schedule state — same family, distinct lifecycle."
- Drop **Reconciler** as a named term — replace references with "the daemon's index loop" or similar.
- Drop **Lock theme** as a named term — describe `qmd-{download,index,embed}` as named locks.
- Update the IPC primitive list to 6 file-based + 1 POSIX.

**Acceptance:**
- [ ] "Snapshot" no longer appears as a primitive in CONTEXT.md
- [ ] Marker description includes the lazy-signal framing
- [ ] Refire is documented as Kick + retry state
- [ ] "Reconciler" no longer appears as a named term
- [ ] "Lock theme" no longer appears as a named term
- [ ] IPC primitive count reads as 6 file-based + 1 POSIX (Signal)
- [ ] Example dialogue still parses with the new terminology

---

## Phase 5: Kill 1Hz heartbeat → event-driven status writes

**User stories:** daemon doesn't write to disk every second when idle; `dither status` shows `lastUpdated` so the human can judge freshness.

- Delete the 1Hz `setInterval` in `daemon.ts` that rewrites `status.json`.
- Convert `writeStatus()` (or equivalent) into a function called at state-change sites: daemon startup, SIGHUP reload, run start, run end, loop-detector halt, graceful shutdown.
- Replace `heartbeat` / `lastBeat` field with `lastUpdated` (ISO timestamp of last real change).
- Update `probeDaemon` in `daemon-control.ts` to use: pid file existence + `kill(pid, 0)` + token match. Remove `STATUS_FRESH_MS` and the 15s freshness check.
- Update `commands/status.ts` to display `lastUpdated: "Nm ago"` so humans can judge staleness.

**Acceptance:**
- [ ] No `setInterval` writes `status.json` in `daemon.ts`
- [ ] `status.json` written on each of: startup, SIGHUP reload, run start, run end, halt, shutdown
- [ ] `lastUpdated` field present; `heartbeat`/`lastBeat` removed
- [ ] `probeDaemon` uses pid + kill(0) + token; no freshness window
- [ ] `STATUS_FRESH_MS` constant deleted
- [ ] `dither status` displays "Nm ago" for `lastUpdated`
- [ ] `daemon.test.ts` / `daemon-control.test.ts` / `status.test.ts` pass (some assertions about heartbeat update to assert event-driven writes instead)

---

## Phase 6: Markers extraction + `<home>/markers/` layout

**User stories:** marker writers and readers don't import from `daemon-jobs.ts`; marker files live in a tidy subdirectory like every other IPC primitive.

- Create `packages/cli/src/markers.ts` exporting:
  - `needsReindexPath()`, `embedDisabledPath()` (point to `<home>/markers/<name>`)
  - `requestReindex()`, `clearReindex()`
  - `disableEmbed()`, `enableEmbed()`
  - `readMarkerState()` returning `{ needsReindex: boolean, embedDisabled: boolean }`
- Update all callers to import from `markers.ts` instead of `daemon-jobs.ts`:
  - `promotion.ts:10, 144` (fixes the SDP violation)
  - `daemon.ts:18, 346`
  - `daemon-jobs.ts` body (delete marker path helpers + MarkerState type)
  - `commands/init.ts:22, 359`
  - `commands/index.ts:6, 36, 59, 81, 85, 128`
  - `commands/status.ts` references
- Auto-migration: on first run after this change, if `<home>/needs-reindex` exists, move it to `<home>/markers/needs-reindex`. Same for `embed-disabled`. Idempotent.
- Create `markers.test.ts` covering paths, write/clear, and the migration.

**Acceptance:**
- [ ] `markers.ts` exists with the named exports
- [ ] No other file imports marker path helpers from `daemon-jobs.ts`
- [ ] Markers live at `<home>/markers/needs-reindex` and `<home>/markers/embed-disabled`
- [ ] Auto-migration moves old top-level marker files on first run; idempotent
- [ ] `daemon-jobs.ts` shrinks (no marker path helpers, no MarkerState type)
- [ ] `markers.test.ts` covers happy path + migration
- [ ] Existing tests pass

---

## Phase 7: Command-prefix rename + `commands/plugin.ts` split

**User stories:** new contributor scanning `commands/` immediately knows each file is a CLI command; `commands/plugin.ts` no longer hides six subcommands inside one 785-LOC file.

Two coordinated moves in one commit:

**A. Rename all command files** with `command-` prefix:
- `commands/collection.ts` → `commands/command-collection.ts`
- `commands/daemon.ts` → `commands/command-daemon.ts`
- `commands/env.ts` → `commands/command-env.ts`
- `commands/get.ts` → `commands/command-get.ts`
- `commands/index.ts` → `commands/command-index.ts` (also fixes JS barrel collision)
- `commands/init.ts` → `commands/command-init.ts`
- `commands/search.ts` → `commands/command-search.ts`
- `commands/status.ts` → `commands/command-status.ts`
- `commands/plugin-oauth.ts` → `commands/command-plugin-oauth.ts`
- All matching `*.test.ts` files renamed in parallel.

**B. Split `commands/plugin.ts`** (785 LOC, fanOut=22) into:
- `commands/command-plugin.ts` — slim dispatcher (~80 LOC; `defineCommand` with `subCommands` map)
- `commands/command-plugin-install.ts` — install subcommand (includes `handleProtectedInstall`)
- `commands/command-plugin-run.ts` — run subcommand (includes the run-tailing block from `plugin.ts:684-713`)
- `commands/command-plugin-runs.ts` — runs (listing) subcommand
- `commands/command-plugin-list.ts` — list subcommand
- `commands/command-plugin-remove.ts` — remove subcommand
- `commands/command-plugin-oauth.ts` — already exists as a peer (renamed in A)
- Each subcommand file exports its own `defineCommand` object. `command-plugin.ts` imports and wires them into the `subCommands` map.

**C. Update `main.ts`** import paths for all renamed commands.

**Acceptance:**
- [ ] All files in `commands/` start with `command-`
- [ ] `commands/command-plugin.ts` is the dispatcher only (no inline subcommand bodies, no `handleProtectedInstall`, no run-tailing block)
- [ ] Each plugin subcommand has its own file
- [ ] `main.ts` imports all renamed commands
- [ ] `dither --help` and each subcommand's `--help` produce equivalent output to before
- [ ] All command tests pass (rename test files in parallel)
- [ ] No duplicate imports in `command-plugin.ts` (the audit found `relative-time`, `run-log`, `home` each imported twice in the original)

---

## Phase log

|  commit  |  summary  |
|----------|-----------|
|          |           |
