# Retire "home" vocabulary

> Written mid-implementation (should have come first — logged in PAPERCUTS).

## Problem

- May's `home → configDir` rename fixed the status JSON but left the old word everywhere: `home.ts`, `resolveHome()`, `$DITHER_HOME`, `<home>` in comments, a dead `DaemonStatus.home` field.
- "Home" conflates dither's machine state with the user's OS home and the library. Two concepts remain: **config dir** (dither's state) and **library** (user content, default collection root; externals cover extra roots — one library is enough).

## Change

- `home.ts` → `paths.ts`; `resolveHome()` → `configDir()`. (~28 import sites, 17 files)
- Drop `$DITHER_HOME` env alias + its warn latch + `_resetHomeWarningLatch` (never released; chain is now DITHER_DIR → XDG → `~/.dither`).
- Drop `DaemonStatus.home` (written, never read; duplicates `DitherStatus.configDir`).
- Comments: `<home>/...` → `<config>/...`; `home.ts` refs → `paths.ts`. "User's home" (OS homedir) comments stay.
- Docs: CONVENTIONS.md layout tree + path-getter row; fix the wrong "defaults to ~/.config/dither" claim (fallback is `~/.dither`).
- Test-local `home` variables stay — they name temp dirs, churn without value.

## Acceptance

- [x] no `resolveHome` / `DITHER_HOME` / `DaemonStatus.home` in src
- [x] tsc clean, suite green
- [x] CONVENTIONS.md matches the new names
