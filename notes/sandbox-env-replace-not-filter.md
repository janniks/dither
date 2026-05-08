---
status: thinking
priority: P2
---

# Plugin sandbox: replace the env, don't filter it

## Problem

Today's plugin host spreads `process.env` into the Deno child env then narrows
visibility via `--allow-env=DITHER_*`. Two issues:

1. **Leaky by default.** Even though `--allow-env` restricts *reads*, every var
   is still *present* in the child's address space. Anything that escapes the
   sandbox via a future bug or transitive dep can still see secrets.
2. **Plugins keep blowing up at import** on libraries that probe `process.env`
   for behaviour switches: `jsdom` (via `debug`), `unzipper` (via
   `readable-stream`), `yauzl-promise` (via `@node-rs/crc32`),
   `Object.keys(process.env)` calls in `debug`'s startup.

## Decision

Build the child env from a **literal**, not by filtering the host's env.
`spawn(deno, args, { env: literal })` replaces the parent env entirely; the
child only sees what we list. No "auto-cleaning" rules, no allowlist over
existing vars — just a hardcoded shim.

## Hardcoded shim

```ts
const PLUGIN_ENV = {
  // dither-supplied bootstrap pointers
  DITHER_RUN_DIR:    runDir,
  DITHER_INPUT_FILE: inputFile,
  DITHER_STATE_FILE: stateFile,
  DITHER_TRIGGER:    trigger,
  DITHER_PLUGIN_NAME: opts.name,
  // hardcoded behaviour switches that common npm libs probe at import.
  // Values are sanitized: empty / safe defaults that disable dependent paths.
  DEBUG:        "",
  NODE_ENV:     "production",
  FORCE_COLOR:  "0",
  NO_COLOR:     "1",
  // Deno's module cache. We point it at a per-plugin location (or the host's
  // shared cache) — not the user's $DENO_DIR/$HOME default.
  DENO_DIR:     denoCacheDir,
};
```

Matching `--allow-env` list contains exactly these names, and only these.

## Discovery loop

When a plugin transitively depends on a library that probes a name we haven't
shimmed (e.g. `READABLE_STREAM`, `NAPI_RS_FORCE_WASI`), it crashes with
`NotCapable: Requires env access to "X"`. Human decides:

- Behaviour switch / public flag / debug name → add to the constant with a
  sanitized value, ship.
- Secret-shaped name (`*_KEY`, `*_TOKEN`, `*_SECRET`, `OPENAI_*`, `AWS_*`) →
  refuse; the dep is too invasive for the plugin sandbox.

The constant grows slowly and visibly — every addition is a code change in
the host, audited in a PR.

## Smoke test (verified 2026-05-08)

Ran a probe with `env -i` clearing all OS env, then Deno via absolute path
with only the 9 hardcoded names:

- ✅ Deno boots.
- ✅ `npm:linkedom` resolves, downloads transitive deps to a fresh `DENO_DIR`,
  imports cleanly, parses HTML correctly.
- ✅ Plugin sees `DITHER_PLUGIN_NAME=probe`, `DEBUG=""`, etc.
- ✅ Reading `HOME` (not in the allowlist) throws `NotCapable` — Deno itself
  does not internally need HOME.
- ✅ npm registry download happens without `--allow-net` from the plugin's
  perspective — Deno's own fetcher operates outside script sandbox.

So the host can use an absolute Deno path (already produced by
`deno-bootstrap.ts`'s `ensureDeno`), pass a literal env, and the child runs
without inheriting anything. No `PATH`, no `HOME`, no `TMPDIR` needed.

## Manifest env routing — decided

Resolved manifest env flows through **both** `process.env` (conventional;
libraries auto-read) **and** `input.json` (structured; via `readInput()`).
Plugin author picks per call site. See `notes/manifest-env-routing.md`
for the full rationale and implementation plan.

The hardcoded shim list above is independent of this — those names live
only in `process.env` with sanitized constant values, and don't appear in
`input.env`.

## Out of scope (this note)

- Auto-classifying secrets vs behaviour switches by name pattern (no auto-
  rules; everything is hand-curated in one constant).
- Per-plugin or per-machine env policy. The shim list is global.
