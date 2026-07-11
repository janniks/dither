# Plan: plugin spawn plan — one pure function, one env constant

> Source spec: `specs/plugin-spawn-plan-DRAFT.md`

## Architectural decisions

- `plan(args) → {denoArgs, env, input}` exported from plugin-run.ts (no new file); all I/O stays in `runPluginLocked`.
- `--allow-env` derived from the DITHER_* record's keys — one literal, can't diverge. `DITHER_ENV_VARS` deleted.
- Behavior-preserving: child env/argv/input.json byte-identical for the same inputs.

---

## Phase 1: extract plan() + in-memory permission tests

**Acceptance:**
- [x] `plan(args)` pure, exported; returns `{denoArgs, env, input}`
- [x] `--allow-env` = keys of the env record; `DITHER_ENV_VARS` deleted
- [x] comma-rejection, watch-root ARG_MAX fallback, bare `--allow-net` each tested in-memory (no spawn)
- [x] existing spawn tests pass unchanged

---

## Phase log

|  |  |
|--|--|
| eabedc5 | Phase 1: pure plan(), derived allow-env, in-memory tests |
