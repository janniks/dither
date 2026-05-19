# Lock module merge

> Architectural deepening — collapses `qmd-locks.ts` into `locks.ts`. **Lock theme** awareness becomes a config table, not a wrapper module.

## Problem Statement

Two lock modules exist in `packages/cli/src/`:

- `locks.ts` (109 lines) — generic per-name lock primitive with atomic O_EXCL acquire, PID-only body, and stale-PID reclaim. Used for plugin-run locks and `daemon-start` coordination.
- `qmd-locks.ts` (144 lines) — a wrapper that prefixes lock names with `qmd-`, adds a **Lock theme** enum (`download | index | embed`), exposes mtime-derived "busy since" metadata, and reimplements `isPidAlive` from scratch.

`qmd-locks.ts` fails the deletion test: removing it would push three `qmd-` string literals into call sites and replace its `tryAcquireQmdLock` with direct `acquire("qmd-index")` calls. The complexity does not concentrate; it dissipates. The only real value the wrapper adds is:

- A typed **Lock theme** rather than free-form strings.
- A read-side `qmdLockStatus()` for `dither status` and `dither search`'s "embedding still in progress" footer.

That value is real, but it does not need a separate module. It needs a small extension to `locks.ts`.

Today, callers must remember:

- Which file the function they want lives in (`acquire` vs `tryAcquireQmdLock`).
- That `plugin-run.ts` imports both (for the plugin-run lock and for the qmd-index lock).
- That `isPidAlive` exists twice with the same body.

## Solution

Promote `locks.ts` to know about themes and read-side queries. Delete `qmd-locks.ts`. Callers import one symbol surface.

The **Lock theme** registry — three named themes for qmd — becomes a small `const` table inside `locks.ts` (or a sibling file that `locks.ts` re-exports). The plugin-run lock continues to use a per-plugin lock name as before; the API has both styles:

- `acquire(name)` for arbitrary named locks (unchanged behaviour, unchanged shape).
- `acquireTheme(theme)` for typed **Lock theme** locks. Returns the same handle.
- `status(theme)` and `statusAll()` for read-side mtime + PID inspection.

`isPidAlive` lives in exactly one place.

## User Stories

1. As a CLI maintainer, I want one lock module, so that I do not have to choose between two when adding a call site.
2. As a CLI maintainer, I want `isPidAlive` to exist once, so that a bug fix in stale-PID detection applies everywhere.
3. As a `dither status` author, I want a typed read-side API to query **Lock theme** state, so that I do not stringly-type lock names.
4. As a `dither search` author, I want a one-line check for "is an embedding in progress", so that the footer rendering stays trivial.
5. As a test author, I want to acquire test locks without learning two APIs, so that test setup is uniform.

## Implementation Decisions

### Module shape

- `locks.ts` keeps the existing `acquire(name)` / `release(handle)` surface intact (call sites that use it for plugin-run and daemon-start are unchanged).
- `locks.ts` gains `acquireTheme(theme: LockTheme)` and `releaseTheme(handle)` thin wrappers. The wrapper just translates the theme to a string via the registry and delegates.
- `locks.ts` gains `status(theme): LockEntry | null` and `statusAll(): Record<LockTheme, LockEntry | null>`. Both inspect on-disk lock files; both filter dead PIDs via the now-single `isPidAlive`.
- A `lockPath(theme)` accessor exists for tests and the `dither search` footer.

### Theme registry

**Q12 decided: (b) short literals.** `type LockTheme = "download" | "index" | "embed"`. The module name (`locks`) plus the function name (`acquireTheme`) already establish the qmd context. The `qmd-` prefix in lock file paths is implementation detail of where the lock file lives, not part of the theme's identity.

- `LOCK_THEMES: readonly LockTheme[]` exported for iteration (used by `statusAll` and `dither index cancel`).
- **Q15 decided: (a) themes live inside `locks.ts`.** The whole point of the merge is one place to look. A sibling `theme-locks.ts` would recreate today's two-module shape under a new name.

### Read-side API

**Q14 decided: (a) null for stale.** `status(theme)` returns `{startedAt, pid} | null`. Stale entries return `null` — no caller currently distinguishes "no lock" from "stale lock"; the next acquirer reclaims them. If `dither status` ever wants to surface stuck-lock detection, a separate `staleLocks()` accessor is more honest than overloading `status()`.

- `statusAll()` is a thin loop over `LOCK_THEMES` calling `status`.

### Migration

**Q13 decided: (a) collapse to `LockHandle | null`.** 80% of call sites only care about acquire/no-acquire; the rare caller that wants `startedAt` explicitly asks `status(theme)`.

- All `tryAcquireQmdLock("index")` call sites become `acquireTheme("index")`.
- All `qmdLockStatus()` callers become `statusAll()`.
- All `qmdLockPath("embed")` callers become `lockPath("embed")`.
- `qmd-locks.ts` is deleted in the same change.

### Backwards compatibility

- The on-disk lock-file names (`qmd-download.lock`, `qmd-index.lock`, `qmd-embed.lock`) are unchanged. A daemon and CLI running across the upgrade boundary still see each other's locks.

## Testing Decisions

- Test the merged `locks.ts` through `acquire` / `acquireTheme` / `status`. Cover: clean acquire-release, contention, stale-PID reclaim, mtime-derived `startedAt`, theme registry exhaustiveness.
- Existing `locks.test.ts` keeps its assertions about the per-name path.
- `qmd-locks.test.ts` assertions move into `locks.test.ts`; the file is deleted.
- Call-site tests (`commands/index.test.ts`, `cli-dispatch.test.ts`) keep their behavioural assertions; only their imports change.

Prior art: `locks.test.ts` and `qmd-locks.test.ts` both already exercise the file-system surface directly. Merge follows the same pattern.

## Out of Scope

- Replacing PID-file locks with `flock(2)` or `fcntl` advisory locks.
- A reader-writer lock variant.
- A blocking-acquire mode with timeout.
- Cross-host coordination.

## Further Notes

- This is the smallest of the five deepening specs and is safe to land first. It does not depend on the **Run-log unification** or **DaemonClient seam** specs.
- The friction signal is duplicated code (`isPidAlive` twice). The deletion test makes the asymmetry clear: deleting `qmd-locks.ts` reduces total LOC; deleting `locks.ts` would require reimplementing it inside `qmd-locks.ts`.
