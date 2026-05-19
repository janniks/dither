# Plan: Lock module merge

> Source spec: `specs/lock-module-merge.md`

## Architectural decisions

- One module (`locks.ts`) owns both generic per-name locks and theme-aware locks.
- **Lock theme**: `"download" | "index" | "embed"` (short literals); `qmd-` prefix is internal to lock-file naming.
- `acquireTheme(theme)` returns `LockHandle | null` (busy-since metadata via `status(theme)`).
- `status(theme)` returns null for stale entries.
- `qmd-locks.ts` is deleted.
- On-disk lock-file names (`qmd-download.lock`, etc.) unchanged.

---

## Phase 1: Extend `locks.ts` with theme awareness

**User stories**: 1, 3

End-to-end: `locks.ts` exports `LockTheme`, `LOCK_THEMES`, `acquireTheme`, `releaseTheme`, `status`, `statusAll`, `lockPath`. Behaviour matches today's `qmd-locks.ts`. Generic `acquire`/`release` stay intact. New tests cover the theme surface.

**Acceptance:**
- [ ] `LockTheme = "download" | "index" | "embed"` exported from `locks.ts`.
- [ ] `acquireTheme("index")` writes `~/.dither/locks/qmd-index.lock`.
- [ ] `status("index")` returns `{startedAt, pid} | null`; stale (dead-PID) entries return null.
- [ ] `statusAll()` returns `Record<LockTheme, LockEntry | null>`.
- [ ] `isPidAlive` exists exactly once in the package.
- [ ] New theme-surface tests pass.

---

## Phase 2: Migrate call sites and delete `qmd-locks.ts`

**User stories**: 2, 4, 5

End-to-end: every importer of `qmd-locks` switches to `locks`. `qmd-locks.ts` and `qmd-locks.test.ts` deleted. Tests still green.

**Acceptance:**
- [ ] No `qmd-locks` references remain (search confirms).
- [ ] `commands/index.ts`, `daemon-jobs.ts`, `plugin-run.ts`, `commands/init.ts`, `commands/search.ts`, `status.ts` call `acquireTheme`/`status`/`lockPath` instead of the `qmd*` names.
- [ ] `qmd-locks.ts` deleted; `qmd-locks.test.ts` deleted (assertions absorbed by `locks.test.ts`).
- [ ] `npm test` and `npm run typecheck` pass.

---

## Phase log

|  |  |
|--|--|
|  |  |
