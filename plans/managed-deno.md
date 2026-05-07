# Plan: Managed Deno

> Source spec: `specs/managed-deno.md`. Two phases. Phase 1 is the full
> end-to-end vertical slice on macOS targets; Phase 2 extends the matrix to
> Linux. Spec headline decisions are not revisited here.

## Architectural decisions

- **Versioned path.** Pinned binary lives at `~/.dither/bin/deno-<version>`. Older versioned binaries linger as a rollback safety net; no symlink, no auto-cleanup.
- **Pinned hashes in source.** The `(version, target) → sha256` table is hard-coded in `deno-bootstrap.ts`. The release-side `.sha256sum` is not trusted. Bumping Deno is a single PR that updates the version constant and every supported-target hash.
- **Lazy bootstrap, single function.** `ensureDeno()` is idempotent: returns the binary path if already installed, otherwise downloads → verifies → extracts → atomically renames into place. Today's call sites (`plugin install`, `plugin run`) call it lazily; a future eager `dither init` calls the same function.
- **Opt-out only, no auto-detect.** `DITHER_USE_SYSTEM_DENO=1` resolves Deno from `PATH` and short-circuits the bootstrap. Documented as a developer/CI escape hatch only.
- **Mac + Linux matrix.** v0 supports `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`. Other platforms throw a clear error pointing at the opt-out.
- **Temp-then-rename.** Download lands in `~/.dither/bin/.tmp-<uuid>.zip`, gets sha256-verified, the binary is extracted, `chmod +x`'d, and atomically renamed to the final versioned path. Failures leave no partial install.
- **Concurrency via existing `locks.ts`.** Two parallel `ensureDeno()` calls coordinate under a `bin:deno-<version>` lock; the loser waits, re-checks, short-circuits.
- **One-line status, no progress bar.** One stderr line before the download, one after.

---

## Phase 1: Lazy bootstrap end-to-end (macOS targets)

**User stories:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12.

End-to-end behavior: a user with no Deno on PATH runs `dither plugin install` and `dither plugin run`. On the first call, dither downloads the pinned Deno for the current macOS arch, sha256-verifies it against the embedded hash, atomically installs it at `~/.dither/bin/deno-<version>`, and spawns the plugin from there. Subsequent calls short-circuit. `DITHER_USE_SYSTEM_DENO=1` skips the bootstrap entirely. `tcc-hint`'s FDA error points at the managed binary path. Concurrent callers coordinate via the existing per-name lock so exactly one download happens.

**Acceptance:**

- [x] `deno-bootstrap.ts` exports `ensureDeno()`. Pinned version constant + macOS hash table embedded in source.
- [x] `home.ts` exports `binDir()`.
- [x] `plugin-run.ts` and `plugin-install.ts` spawn / bootstrap from `await ensureDeno()`.
- [x] `DITHER_USE_SYSTEM_DENO=1` short-circuits to `which deno` resolution.
- [x] Concurrent `ensureDeno()` callers coordinate via `locks.ts`; exactly one download.
- [x] Failed download/verify leaves no binary at the final path; throws an expected error with retry hint.
- [x] One stderr status line before download, one after; no byte-level progress bar.
- [x] `tcc-hint.ts`'s `formatFdaError` defaults its `callerBinary` argument to the managed binary path; `plugin-run.ts` passes that path through.
- [x] `deno-bootstrap.test.ts`: happy path (mock fetcher), hash mismatch, concurrency, opt-out, idempotency.
- [x] Existing tests set `DITHER_USE_SYSTEM_DENO=1` so they don't pull a real binary.
- [x] Lint, typecheck, full suite green.

---

## Phase 2: Linux targets

**User stories:** 10.

End-to-end behavior: same flow works on Linux. Two new rows in the hash table; arch detection extended; unsupported platforms throw a clear error.

**Acceptance:**

- [x] `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu` added to the hash table.
- [x] Target detection picks Linux up via `process.platform === "linux"` + `process.arch`.
- [x] Unsupported platform throws a clear "platform not supported" error mentioning `DITHER_USE_SYSTEM_DENO=1` as the workaround.
- [x] Lint, typecheck, full suite green.

---

## Phase log

| phase | commit | summary |
| ----- | ------ | ------- |
| 1 | 58a8470 | mac-only managed-deno bootstrap, ensureDeno() wired into plugin install + run, FDA hint repointed |
| 2 | 63cc032 | linux x64 + arm64 hashes added, target detection extended |
