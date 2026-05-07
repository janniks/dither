# Managed Deno

> Dither downloads, verifies, and runs a pinned Deno binary at a stable, dither-controlled path. That binary becomes the singular Full Disk Access grant target on macOS — the future `dither init` command builds the user-visible FDA flow on top.

## Problem Statement

Two coupled problems today.

1. **Plugins require a Deno install.** Users have to install Deno v2.x out-of-band before any dither plugin works. That's friction on first install, and it makes the plugin runtime version a moving target — every system Deno upgrade is a potential behavior change for already-installed dither plugins.

2. **macOS FDA has no usable target.** The plugin process is the binary actually performing protected-data reads (e.g. iMessage's `chat.db`). Granting Full Disk Access to the system `deno` is fragile (path drift on Homebrew/asdf upgrades, code-signature drift, scope leaks into every Deno tool the user runs); granting FDA to a Node binary is broader still. Users either grant FDA to their entire terminal app (overbroad and unrevokable per-tool) or give up. Neither matches dither's "narrow, opt-in capability" stance.

## Solution

Dither owns its Deno. On first need, dither downloads a pinned Deno release from the official GitHub release URL, verifies it against a SHA-256 hash hard-coded in dither's source, and installs it at `~/.dither/bin/deno-<version>`. Plugin runs spawn that exact path.

The single managed-binary path becomes the durable FDA target. A user grants FDA once to `~/.dither/bin/deno-<version>`; the grant survives system Deno upgrades, brew/nvm churn, and dither updates that don't bump the pinned Deno version. The eventual `dither init` command (separate spec) reveals this binary in Finder, opens the FDA settings pane, and walks the user through the grant in one minute — but that command isn't built in this spec. This spec lays the binary management foundation it needs.

Lazy bootstrap means today's call sites (`plugin install`, `plugin run`) trigger the download on first use; the same `ensureDeno()` function is what the future eager `dither init` command will call.

## User Stories

1. As a new dither user, I want `npm install -g dither` to be a complete install — no out-of-band "install Deno first" step — so my first plugin install just works.
2. As a user, I want my plugin runtime to be a known, pinned version so plugin behavior doesn't drift when I upgrade my system Deno.
3. As a user, I want a single, stable binary path I can grant Full Disk Access to once on macOS, so I don't have to re-grant on every Homebrew upgrade.
4. As a user, I want Deno version bumps in dither to be deliberate, code-reviewed events so a transparent compromise of the upstream release page can't silently install a tampered binary on my machine.
5. As a developer or CI environment, I want an env-var escape hatch to use the system Deno (skipping the bootstrap) so I'm not downloading a 30 MB binary in unrelated tests.
6. As a user, I want lazy bootstrap so I don't pay the download cost until I actually try to run a plugin.
7. As a future-me building the `dither init` command, I want the bootstrap factored into one idempotent function that the setup command can call eagerly without any code duplication.
8. As a user, I want concurrent `dither plugin install` calls to coordinate and download Deno once, not race and download it twice.
9. As a user on a flaky network, I want a failed download to leave no half-installed binary on disk; re-running the same command should retry cleanly.
10. As a user on Linux, I want managed Deno to work for the reproducibility and "no Deno install required" benefits, even though Linux has no FDA equivalent.
11. As a maintainer reading code months from now, I want the version constant, hash table, and bootstrap logic in one file so a Deno bump is a small, locally-reasoned PR.
12. As a user, I want older versioned Deno binaries to linger after a bump so I have a trivial rollback path while a new version proves itself.

## Implementation Decisions

### Binary layout

- Pinned binary lives at `~/.dither/bin/deno-<version>`. The `<version>` segment is part of the path. No symlink.
- Plugin-run spawns from that exact path. The version dither uses is whatever the source says.
- Older versioned binaries are not auto-deleted on a bump; they linger as a rollback safety net. A `dither bin clean` command can be added later if disk usage becomes a real concern.
- The bin dir lives under `DITHER_HOME`, so tests with a sandboxed `DITHER_HOME` get their own bin dir.

### Bootstrap is lazy, factored to support future eager call sites

- One idempotent function: `ensureDeno()` returns the absolute path to a verified binary. If the pinned binary already exists at the expected path, it returns immediately. Otherwise it downloads, verifies, installs, then returns. No retries, no progress bar.
- Today's call sites are `plugin install` and `plugin run`, both of which call `ensureDeno()` lazily.
- A future `dither init` command calls the same function eagerly, then layers the FDA UX (Finder reveal, Settings deep link) on top. No `init`-vs-`run` branching inside the bootstrap.

### Source + integrity

- Download URL: `https://github.com/denoland/deno/releases/download/v<X.Y.Z>/deno-<target>.zip`.
- Verification: SHA-256 against a hard-coded table in dither's source mapping `(version, target) → sha256`. The release-side `.sha256sum` file is **not** trusted (it's compromised by the same vector that would compromise the binary).
- Bumping Deno = a single PR that updates both the version constant and the hash table for every supported target. Hashes are computed on a trusted machine and attested in the PR description.

### Platform / arch matrix (v0)

- macOS: `aarch64-apple-darwin`, `x86_64-apple-darwin`.
- Linux: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`.
- Windows is not supported in v0. A user on an unsupported platform sees a clear error pointing at the env-var opt-out.

### Opt-out

- `DITHER_USE_SYSTEM_DENO=1` resolves `deno` from `PATH` and skips the entire bootstrap. Documented as a developer/CI escape hatch only — no auto-detection, no auto-prefer-when-available. The managed binary is the default for all real use.

### Robustness

- Download lands in `~/.dither/bin/.tmp-<uuid>.zip`, gets sha256-verified against the source-pinned hash, gets extracted into a temp dir, the deno binary gets `chmod +x`'d, then the binary file is atomically renamed to `~/.dither/bin/deno-<version>`. POSIX rename is atomic on the same filesystem; the temp paths live alongside the final path so this always holds.
- On any error in the chain, the temp artifacts are deleted and an expected `KnownPluginFailure`-style error surfaces with a clean message, the failing URL, and a "retry: re-run the same command" hint.
- Concurrency uses the existing `locks.ts` infrastructure under a `bin:deno-<version>` key. The second caller waits for the first, then re-checks existence and short-circuits. No double download.

### Modules

- **`deno-bootstrap.ts`** (new, deep, isolated). Sole export: `ensureDeno()`. Internal: pinned version constant, sha256 table, target detection from `process.platform` + `process.arch`, lock-guarded download, temp-then-rename, error formatting. No caller outside this file knows about versions, hashes, or extraction.
- **`plugin-run.ts`** (light edit). `spawn("deno", …)` becomes `spawn(await ensureDeno(), …)`. No other change.
- **`plugin-install.ts`** (light edit). Same call early in the install path, so install also triggers bootstrap on first use.
- **`home.ts`** (light edit). Add `binDir()` returning `~/.dither/bin/`.

### Progress reporting

- One stderr status line before the download (`"downloading deno v<X.Y.Z> (~<N> MB)…"`), one after (`"installed deno v<X.Y.Z>"`). No byte-level progress bar. Keeps lazy-bootstrap-from-plugin-run unobtrusive.

### FDA implications (the second half of the spec)

- The managed binary is the recommended FDA target on macOS. The existing `formatFdaError` in `tcc-hint.ts` should point users at `~/.dither/bin/deno-<version>` (the path returned by `ensureDeno()`) instead of `process.execPath`.
- Whether macOS TCC actually honors a per-binary FDA grant on the managed Deno when launched from a non-FDA terminal is the open empirical question (`notes/deno-fda-experiment.md`). This spec doesn't decide that; it just makes the experiment runnable.
- The actual `dither init` command — Finder reveal + Settings deep link + Y/n auto-open — is a sibling spec. Its dependency on this one is a single function call.

## Testing Decisions

External-behavior tests only.

- **`deno-bootstrap.test.ts`** (new):
  - Happy path: a small fixture HTTP server (or mock fetch) returns a known artifact + matching hash; assert binary lands at the expected path with the executable bit set.
  - Hash mismatch: server returns mangled bytes; assert no binary lands at the final path, the temp is gone, and an expected error is thrown.
  - Concurrency: two parallel `ensureDeno()` calls; assert exactly one download attempt was made and both resolve to the same path.
  - System-deno opt-out: `DITHER_USE_SYSTEM_DENO=1`; assert no fetch attempted and the returned path is whatever `which deno` resolves to.
  - Idempotency: second call returns immediately when the binary already exists.

- **`plugin-host.test.ts`** (existing): already sets `DITHER_USE_SYSTEM_DENO=1` so existing tests don't pull a real binary. Add a single assertion that `runPlugin` spawns from the `ensureDeno()` path (covered indirectly by the spawn-arg path).

Prior art: the existing `plugin-host.test.ts` "install + run" integration test is the template — sandbox `DITHER_HOME`, run end-to-end, assert filesystem outcomes.

## Out of Scope

- The `dither init` / `dither init` command (Finder reveal, Settings deep link, Y/n auto-open prompt). Sibling spec; depends on this one.
- Self-update of Deno without a dither-version PR. Manual, deliberate bumps only.
- Code-signing dither itself or the daemon.
- Daemon work (launchd LaunchAgent, self-respawn). Tracked in `notes/fda-and-the-daemon.md`.
- Cleanup of older versioned binaries (`dither bin clean`). Future, when there's signal it matters.
- Windows support.
- A progress bar during download. One-line status before / after only.

## Further Notes

- The Linux half of this spec is purely about reproducibility and removing the system-Deno install requirement; FDA is mac-only.
- `notes/deno-fda-experiment.md` captures the empirical question this spec unblocks: with FDA granted *only* to `~/.dither/bin/deno-<version>`, does macOS TCC honor it for plugin reads? If yes, the FDA story is solved without a daemon. If no, the daemon spec follows next and uses managed Deno as a prerequisite.
- The version constant and hash table together are the "trust anchor" of the bootstrap. Their PR is the security-critical event; everything else is mechanical.
