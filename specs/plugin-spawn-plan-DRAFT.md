# Plugin spawn plan — one pure function, one env constant

Source: architecture review 2026-07-10 + intent check (trust-model notes respected). Behavior-preserving refactor only; the two pending env-model changes (`notes/sandbox-env-replace-not-filter.md`, `notes/manifest-env-routing.md`) land separately.

## Problem

- `runPluginLocked` (plugin-run.ts:163–354, ~190 lines) does everything in one stretch: layer grants, copy state, claim inbox, write input.json + import map, resolve watch roots, build every Deno `--allow-*` arg, build the child env, spawn, promote, commit state.
- The permission math is only reachable by spawning a fake Deno child. Comma-rejection (plugin-host.test.ts:76), write-dir scoping (plugin-run.test.ts:157), and the bare `--allow-net` for `["*"]` (plugin-run.ts:291) are each tested through an EventEmitter/PassThrough fake — slow, noisy, indirect.
- The DITHER_* env contract is hand-written in three unlinked places: the allow-env name list `DITHER_ENV_VARS` (plugin-run.ts:53–59), the env record values (plugin-run.ts:299–306), and the SDK reading each name by string (packages/plugin/src/index.ts). Add a var to the record but forget the list → silent PermissionDenied in the child.

## Solution

- Extract one pure, exported function in plugin-run.ts (no new file): `plan(args) → { denoArgs, env, input }`. `args` is already-resolved data: name, trigger, paths (pluginDir, runDir, sdkPath, importMapPath, inputFile, stateFile), grantFiles, grantNet, resolvedEnv, watchRoots, targets.
  - All I/O (mkdir, copyFile, claimInbox, resolveWatchPath, resolveLibraryRoot, writeFile, spawn, promote) stays in `runPluginLocked`; it resolves inputs, calls `plan`, writes `input`, spawns with `denoArgs`/`env`.
  - The comma check, watch-root ARG_MAX fallback, and bare-`--allow-net` branch move inside `plan` — testable with plain objects.
- Kill the env divergence: build the DITHER_* env as one record literal `{ DITHER_RUN_DIR: runDir, … }`, then derive `--allow-env` from `Object.keys` of that record. The list cannot disagree with the record — they are the same object. Delete `DITHER_ENV_VARS`.
- SDK: keep its string-literal reads. A wrong name there throws loudly at read time (caught by the real-spawn host test), unlike the silent CLI list/record drift. Sharing a constant from `@dither/plugin` is possible but deferred — the CLI-local fix already removes the one silent failure mode.

## Constraints (must not break)

- The child receives exactly what it does today — env construction, input.json shape `{trigger, env, files, targets, net}`, argv semantics all unchanged.
- Grants stay process-level; input.json keeps carrying resolvedEnv.
- `runs/<runId>` still `rm -rf`'d in `finally` (input.json holds plaintext secrets).
- `plan` returns env as a plain record so the pending env-model changes land later as a one-spot edit.

## LOC

- plugin-run.ts: ~60 lines move from `runPluginLocked` into `plan`; `DITHER_ENV_VARS` (7 lines) deleted; source ~flat.
- Tests: comma-rejection (~26 lines) and write-dir scoping (~20 lines) become ~5-line in-memory assertions on `plan`; bare-`--allow-net` gains a direct test it never had. Net test LOC −30 to −40; `fakeSpawn` stays only where a spawn is genuinely needed.

## Acceptance

- [ ] `plan(args)` exists, pure, exported; returns `{ denoArgs, env, input }`
- [ ] `--allow-env` derived from the env record's keys; no second hand-written name list; `DITHER_ENV_VARS` deleted
- [ ] comma-rejection, ARG_MAX fallback, and bare-`--allow-net` each have an in-memory test that never spawns
- [ ] `runPluginLocked` still: copies state in, claims inbox, spawns via supervisor, promotes, commits state on clean exit, rm-rf's runDir in `finally`
- [ ] existing plugin-host / plugin-run spawn tests pass unchanged
- [ ] `input.json` and child env byte-identical to today for the same inputs
