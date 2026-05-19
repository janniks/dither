# Plan: Run-log unification

> Source spec: `specs/run-log-unification.md`

## Architectural decisions

- One module replaces `journal.ts` + `events-log.ts` behind a **Run-log** seam.
- Two scopes: `{kind: "global"}` and `{kind: "run", runId}`.
- One event shape: `{ts, kind, scope, runId?, ...payload}`. Closed `EventKind` union.
- Two on-disk paths: `~/.dither/run-log.jsonl` (global) and `~/.dither/history/<runId>/events.jsonl` (run).
- Rotation: 1 MB hard truncate, both scopes.
- `manifest.json` and `result.json` stay as separate files per run.
- No migration (pre-launch).

---

## Phase 1: Build the unified module + tests

**User stories**: 1, 2, 5, 6

End-to-end: new module under a name like `run-log.ts` exposes `append`, `read`, `follow`, `truncate`. Both scopes share the poll-tail primitive. The module is not yet wired into any caller; its tests are self-contained.

**Acceptance:**
- [x] `run-log.ts` exports `appendGlobal/appendRun`, `readGlobal/readRun`, `followGlobal/followRun`, `truncateGlobal`, plus `openRun`, `listRuns`. The scope-named functions replaced the planned `{kind}` discriminator (which would have collided with each event's own `kind` field).
- [x] One closed `EventKind` union covers every event currently emitted by daemon-jobs and plugin-run, plus `job-failed`, `job-skipped` already present in events-log.
- [x] 8 tests cover: write→read round-trip, scope tagging, rotation, ENOENT tolerance, follow streaming, openRun/close lifecycle, listRuns summary states.

---

## Phase 2: Migrate daemon-side callers to global scope

**User stories**: 4

End-to-end: `daemon.ts` and `daemon-jobs.ts` write through `append({kind: "global"}, ...)`. `commands/init.ts` reads via `follow({kind: "global"}, ...)`. Old `events-log.ts` no longer imported from these.

**Acceptance:**
- [x] `daemon.ts` startup/shutdown events flow through `run-log` (`appendGlobal`/`truncateGlobal`).
- [x] `daemon-jobs.ts` job events flow through `run-log` (`appendGlobal`/`readGlobal`).
- [x] `commands/init.ts` watch flow reads via `followGlobal`.
- [x] `events-log.ts` has no remaining production importers (only `events-log.test.ts` remains; deleted in Phase 4 along with the module itself).
- [x] `npm test` and `npm run typecheck` pass — 380 tests green.

---

## Phase 3: Migrate plugin-run to run scope

**User stories**: 3, 4

End-to-end: `plugin-run.ts` opens a run via the new module (`openRun(plugin, trigger)`), appends events through `append({kind: "run", runId}, ...)`. `commands/runs.ts` reads via `follow({kind: "run", runId}, ...)`. Old `journal.ts` no longer imported.

**Acceptance:**
- [x] `plugin-run.ts` uses `run-log.openRun` and emits events via `journal.append({kind, ...})`.
- [x] `manifest.json` and `result.json` continue to be written as today (handled by `openRun`/`close`).
- [x] `commands/runs.ts` tail uses `followRun` plus an in-band poll for `result.json`.
- [x] `journal.ts` has no remaining importers.
- [x] Per-run files are written as `events.jsonl` (via `runEventsPath`).
- [x] `npm test` and `npm run typecheck` pass — 380 tests green.

---

## Phase 4: Delete legacy modules and clean up

**User stories**: 1, 7

End-to-end: `journal.ts` and `events-log.ts` deleted along with their test files; behaviour assertions live in `run-log.test.ts`.

**Acceptance:**
- [x] `journal.ts`, `journal.test.ts`, `events-log.ts`, `events-log.test.ts` deleted.
- [x] `eventsLogPath` removed from `home.ts`.
- [x] No stale imports anywhere.
- [x] Full test suite green — 365 tests pass (was 380 before deletion; -15 net from removing two legacy test files).

---

## Phase log

| commit | summary |
|--|--|
| e7144bb | Phase 1 — `run-log.ts` built with appendGlobal/appendRun/followGlobal/followRun + openRun lifecycle; 8 tests |
| bb5fcd1 | Phase 2 — daemon.ts, daemon-jobs.ts, init.ts migrated to global scope; events-log.ts still in place |
| 4283064 | Phase 3 — plugin-run.ts uses openRun; runs.ts tail rebuilt on followRun + result-poll; journal.ts has no callers |
| 254bfe2 | Phase 4 — journal.ts, events-log.ts + their test files deleted; eventsLogPath removed from home.ts; 837 lines removed |
