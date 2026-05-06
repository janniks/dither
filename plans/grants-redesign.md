# Plan: grants redesign

> Source: user direction 2026-04-29 / 2026-04-30. Supersedes the never-shipped `run-and-install-symmetry.md`. Re-pitches the entire plugin permission model around one concept: **grants**.

## Architectural decisions

- **Three layers:** manifest (declaration) → grants (per-plugin allowance) → globals (managed env values, system-wide).
- **One vocabulary for "user value": `env`.** Replaces `inputs[]` and `permissions.host_env`. Always strings. No `kind`, no `secret` flag — privacy is the user's call (a value with `OPENAI_API_KEY` is a secret because the user said so, not because the plugin tagged it).
- **`net`, `collections`, `files`, `env` are all grants.** Manifest declares the maximum; the user authorizes the actual subset at install. Plugin can request, only the user can give.
- **`permissions` block removed.** `host_net` → top-level `net`. `host_env` is gone (env is the only env). `permissions.browser` removed (was schema-only; the browser sidebar will redefine its own surface when it lands).
- **`collections.writes/reads/auto_create` → flat `collections: string[]`.** Same logic as `net`: manifest declares; user grants. Promote validates against grants, not against the manifest.
- **Global env store** at `~/.dither/env.json`. Managed by `dither env set/get/unset/list`. **Has nothing to do with shell env vars.** Dither manages its own.
- **Reference, not copy.** A plugin granted `--allow-env OPENAI_API_KEY` reads the current global value at every run. Rotate the global once, every plugin sees the new value next run.
- **Run is ephemeral; install grants persistently.** Per-run override flags don't mutate `grants/<name>.json`.
- **`run <path>` auto-installs** if the plugin isn't installed yet (or reinstalls if the same name is). Same flags as `install`.
- **Default-grant-from-manifest at install** when no flag passed. Manifest is the ceiling; flags narrow. `--allow-net api.openai.com` for a manifest declaring two hosts narrows to one.

## Storage shapes

`~/.dither/env.json`:

```json
{ "OPENAI_API_KEY": "sk-...", "ANTHROPIC_API_KEY": "..." }
```

`~/.dither/grants/<plugin>.json`:

```json
{
  "name": "...",
  "version": "...",
  "manifest": {
    /* declared shape, frozen at install */
  },
  "env": { "MAX_RETRIES": "5" },
  "envRefs": ["OPENAI_API_KEY"],
  "files": { "SOURCE": "/abs/path/to/file" },
  "net": ["api.openai.com"],
  "collections": ["notes"]
}
```

Plugin's `input.json` at run time:

```json
{
  "trigger": "manual",
  "env": { "MAX_RETRIES": "5", "OPENAI_API_KEY": "sk-..." },
  "files": { "SOURCE": "/abs/path/to/file" },
  "targets": []
}
```

(Resolution: per-run override > grants.env > grants.envRefs → global > manifest default > error.)

## Manifest shape

```jsonc
{
  "dither": {
    "display_name": "...",
    "tagline": "...",
    "icon": "...",
    "schedule": "every 15m",
    "watch":    { "collections": [...], "glob": "**/*.md" },

    "env": [
      { "name": "OPENAI_API_KEY", "description": "..." },
      { "name": "MAX_RETRIES",    "description": "...", "default": "3" }
    ],
    "files": [
      { "id": "SOURCE", "kind": "file", "required": true }
    ],
    "net":         ["api.openai.com"],
    "collections": ["notes"]
  }
}
```

## CLI grant flags (parallel on `install` and `run`)

- `--env KEY=VALUE` — set per-plugin literal env value (comma-separated for multiple).
- `--allow-env KEY` — grant read access to a global env value (comma-separated).
- `--allow-net HOST` — grant net access to a host (comma-separated).
- `--allow-collection NAME` — grant write access to a collection (comma-separated).
- `--file KEY=PATH` — grant a file/folder path (this _is_ the grant — implies allow-read).

If no flag passed: grant exactly what the manifest declares (defaults from manifest applied).

## Phase 1 — env-only model (replaces inputs)

Manifest, SDK, grants, and CLI flag all rename `inputs` → `env`. Drop `kind`. Drop `secret`. Drop `permissions.host_env`. All env values are strings. SDK `readInput()` returns `{ trigger, env, files, targets }` (no more `config`/`secrets` split).

**Acceptance:**

- [ ] Manifest schema: `env[]` (entries: `name`, `description?`, `default?`). No `kind`. No `host_env` field on permissions.
- [ ] `PluginInput` shape: `{ trigger, env: Record<string,string>, files: Record<string,string>, targets: string[] }`.
- [ ] CLI flag `--env "K=V,K2=V2"` accepted on `install` (and `run`, ahead of phase 4).
- [ ] `echo-config` fixture updated: manifest uses `env[]`, plugin reads `input.env.GREETING` / `input.env.MAX_RUNS` / `input.env.API_TOKEN` (all strings; coerce on use).
- [ ] All other fixtures (`import-folder`, `read-file`, inline counter, escaper, progresser) compile against the new SDK shape.
- [ ] `npm test` all green; binary smoke `install --env "GREETING=hi,API_TOKEN=tok" → run` echoes the values.

## Phase 2 — global env + `dither env` subcommand + `--allow-env`

Add a managed global env store and the CLI to manage it. Wire reference grants into runtime resolution.

**Acceptance:**

- [ ] `~/.dither/env.json` is the store. New `packages/cli/src/global-env.ts` exposes `getGlobalEnv`, `setGlobalEnv`, `unsetGlobalEnv`, `listGlobalEnv`.
- [ ] `dither env set <K> <V>`, `dither env get <K>`, `dither env unset <K>`, `dither env list` — all four subcommands working.
- [ ] Grants schema gains `envRefs: string[]`.
- [ ] CLI flag `--allow-env KEY,KEY2` at install + run.
- [ ] Resolution at run time: per-run > grant.env literal > grant.envRefs (each name → global) > manifest default > error.
- [ ] Tests: global set/list round-trip; plugin with `--allow-env FOO` reads global FOO; rotating global propagates without reinstall; ungranted env not visible.
- [ ] Docs: new `docs/content/docs/cli/env.mdx`; `cli/meta.json` adds `env`.

## Phase 3 — net + collections as grants; drop `permissions` block

Move `permissions.host_net` to top-level `net`. Move `collections.writes` to top-level flat `collections`. Drop `permissions` entirely (no more `host_net`/`host_env`/`browser`). Promote validates against grants.

**Acceptance:**

- [ ] Manifest schema: top-level `net: string[]`, top-level `collections: string[]`. No `permissions` field.
- [ ] Grants gain `net: string[]`, `collections: string[]`.
- [ ] CLI flags `--allow-net "h1,h2"`, `--allow-collection "c1,c2"`.
- [ ] Default-grant-from-manifest if no flag passed.
- [ ] `runPlugin` derives Deno `--allow-net` from `grants.net` (not manifest).
- [ ] Promote validates output `collection:` against `grants.collections`.
- [ ] All fixtures + tests updated.

## Phase 4 — path-aware run + per-run overrides

`dither plugin run <name|path>` accepts a directory path; auto-installs if not installed; reinstalls (idempotent) if it is. All grant flags work on `run` and apply ephemerally (no grants mutation).

**Acceptance:**

- [ ] `existsSync(arg) && contains package.json with dither block` → install-then-run path.
- [ ] `runPlugin` accepts `{ name?, source?, env?, envGrants?, net?, collections?, files? }`. Per-run overrides layer on grants without mutating grants on disk.
- [ ] CLI `run` exposes the same flags as `install`.
- [ ] Tests: per-run env override doesn't mutate grants; per-run file works; `run /path/to/plugin` end-to-end.

## Phase 5 — docs + decision log + review sweep

Bring all docs/decisions/review notes into alignment with the new model.

**Acceptance:**

- [ ] `architecture.md` decision-log entries for: env replaces inputs, grants over contracts, global env, run ephemeral overrides.
- [ ] `llm-decisions.md` — obsolete entries removed (kind/secret/host_env/etc.); new entries added.
- [ ] `reviews/2026-04-29-post-option-c.md` — findings affected by the redesign marked resolved.
- [ ] Docs swept: `cli/plugin.mdx`, `cli/env.mdx`, `cli/index.mdx`, `plugins/index.mdx`, `plugins/authoring.mdx`, `plugins/sdk-reference.mdx`, `concepts/security.mdx`, `concepts/storage.mdx`, `concepts/collections.mdx`. No mention of `inputs`, `host_env`, `permissions.host_net`, `permissions.browser`, `auto_create`, `secret`, `kind`, `config`, `secrets` (the SDK fields).
- [ ] `grep -r "inputs\\[\\]\\|host_env\\|permissions\\.host_net\\|permissions\\.browser\\|auto_create\\|kind:.*secret" docs/ packages/` returns nothing.

## Phase log

| summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phases 1+2+3+4 collapsed into one bundle (no users, no staging benefit). Manifest schema: `inputs[]` → `env[]` (strings only, no `kind`); `permissions` block dropped; `host_net` → top-level `net`; `collections.writes/auto_create/reads` → flat `collections: string[]`. SDK PluginInput: `{ trigger, env, files, targets }` — dropped `config`/`secrets` split. Grants gain `env`, `envRefs`, `net`, `collections`. Global env at `~/.dither/env.json` + `dither env set/get/unset/list`. CLI grant flags `--env`, `--allow-env`, `--file`, `--allow-net`, `--allow-collection` on both `install` and `run`. `plugin run <path>` auto-installs with flags as persisted grants. `plugin run <name>` with flags applies them ephemerally without mutating grants. 36/36 tests; gates clean; binary E2E smoke passed. Phase 5 (docs sweep) next. |
| Phase 5 — docs sweep. Two subagents rewrote `plugins/{index,authoring,sdk-reference}.mdx` and `concepts/{security,storage,collections}.mdx` + `cli/{plugin,index,env}.mdx` + `cli/meta.json` in parallel. `architecture.md` manifest example, env-vs-files section, permission derivation, browser parking-note, and decision log all updated. `llm-decisions.md` plugin-host + grants entries rewritten; obsolete `kind`/coercion language removed. `reviews/2026-04-29-post-option-c.md` findings S3, S4, S7, A8 marked resolved. Final grep confirms no `inputs[]` / `host_env` / `host_net` / `permissions.browser` / `auto_create` / `kind:.*secret` / `input.config` / `input.secrets` left in the source/docs surface. 36/36 tests, typecheck/lint/fmt/build all clean (incl. fumadocs static build).                                      |
