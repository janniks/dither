# llm-decisions

Small decisions I made/defaulted to without explicit user input. Recorded for later review. Each item: what I picked, why, and how to override if you disagree.

> Convention: when something here gets explicitly affirmed or overridden, move it out of this file and into `architecture.md`'s decision log.

---

## Defaults I picked autonomously

### Filesystem layout

| path                                        | purpose                                        | rationale                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.dither/`                                | dither home root                               | Single dot-dir under `$HOME`. Simple, predictable, easy to back up. Considered XDG dirs (`$XDG_DATA_HOME`, etc.) and platform-native (`~/Library/Application Support/dither` on macOS, `%APPDATA%\dither` on Windows) — rejected for v1 in favor of one path everywhere. Override: `DITHER_HOME` env var. |
| `~/.dither/entries/<collection>/...`        | canonical markdown store                       | Inside dither home so backups and sync target one tree. qmd indexes this directory.                                                                                                                                                                                                                       |
| `~/.dither/attachments/<uuid>/<filename>`   | raw attachment blobs                           | Content-addressed by UUID; original filename preserved for human inspection.                                                                                                                                                                                                                              |
| `~/.dither/plugins/<name>/`                 | installed plugin code (immutable post-install) | Author-owned tree.                                                                                                                                                                                                                                                                                        |
| `~/.dither/plugins/<name>/state/state.json` | plugin's persistent state                      | Granted to plugin via Deno flags.                                                                                                                                                                                                                                                                         |
| `~/.dither/grants/<name>.json`              | dither-owned grants per plugin                 | Outside the plugin dir so plugins can't tamper with their own grants.                                                                                                                                                                                                                                     |
| `~/.dither/runs/<run-id>/`                  | ephemeral plugin run scratch                   | Cleaned after promote.                                                                                                                                                                                                                                                                                    |
| `~/.dither/keys/dither.sqlite`              | API key store                                  | SQLite for atomic ops; only metadata + hashed tokens.                                                                                                                                                                                                                                                     |
| `~/.dither/collections.json`                | collection id↔name registry                    | Enables both name-based and id-based grants.                                                                                                                                                                                                                                                              |
| `~/.dither/dither.sqlite`                   | daemon state (run history, schedules)          | Separate DB from keys to keep blast radius low.                                                                                                                                                                                                                                                           |
| `~/.dither/dither.sock`                     | unix socket (CLI ↔ daemon IPC)                 |                                                                                                                                                                                                                                                                                                           |
| `~/.dither/dither.pid`                      | daemon PID file                                | For self-respawn pattern.                                                                                                                                                                                                                                                                                 |

qmd's own index lives at `~/.cache/qmd/index.sqlite` (qmd's default, respects `XDG_CACHE_HOME`). We don't relocate it.

### Watch & schedule defaults

- **Watch glob default**: `**/*.md` when not specified by plugin manifest.
- **Watch debounce**: 5s coalesce window, 30s cap. Configurable per plugin via `watch.debounce`.
- **Self-trigger suppression TTL**: ~2s after promote (in-memory map).
- **Loop detection depth threshold**: 3. After three plugin-trigger chain events, daemon halts and reports.

### Search defaults

- **Default mode**: qmd hybrid (BM25 + vec), reranker off for speed. Opt in via `--rerank`.
- **Default result count**: qmd's default (5). Override via `-n`.
- **Snippet ranges always returned**: agents fetch sections with `dither get <id> --lines start:end`. Full doc opt-in via `--full`.
- **Tests use `mode: "lex"`**: hybrid mode triggers qmd's query expansion + embedding model downloads (~1–2GB on first call). Tests pass `mode: "lex"` (BM25 only, no models) to keep the test suite fast and offline. Production CLI default stays `hybrid`.

### Native dependency note (better-sqlite3)

qmd depends on `better-sqlite3`, which has a native binding compiled per Node version. With the npm registry's `before` config active, prebuild-install couldn't find a prebuilt binary for Node 24. We resolved by running `npm rebuild better-sqlite3` once after install. If we ship a postinstall hook in our published package, it should `npm rebuild better-sqlite3` on user installs OR we should pre-pin a Node version with available prebuilds. Open question to revisit at publish time.

### Plugin host defaults (added during phase 2)

- **SDK uses `node:fs` and `process.env`**, not Deno-native APIs. Works in both Node (typecheck/build) and Deno (runtime via Deno's nodejs compat). Keeps the SDK runtime-agnostic for future flexibility.
- **SDK resolved via `import.meta.resolve("@dither/plugin")` at run time**, not `require.resolve` — `require.resolve` doesn't follow modern `exports` maps without a `require` condition. The result URL is passed to Deno via a per-run `_import-map.json` written into the run dir.
- **Frontmatter emission uses JSON-as-YAML inline values** (`{key}: ${JSON.stringify(value)}`). Avoids a YAML dep in the SDK; gray-matter and yaml libraries parse this fine because YAML is a superset of JSON for primitives.
- **Plugin name auto-stamped to `source` frontmatter** by the SDK using `DITHER_PLUGIN_NAME` env. Plugins cannot fake another plugin's source — the daemon validates `source === <plugin name>` at promote, before the file moves into entries/.
- **Collection ACL enforced at promote**: every output file's `collection:` frontmatter is checked against the plugin's `collections.writes` grant. Mismatches throw and the entire run fails (no partial promote). v1 is fail-closed; partial-promote with per-file errors is a v2 ergonomics question.
- **Install is idempotent**: `dither plugin install <path>` replaces an existing install for that name. No merge, no version bookkeeping in v0; phase 3 will add the explicit-update flow.
- **Plugin runs use stdio: "inherit"** — plugin stdout/stderr go straight to the user's terminal. Captured-log mode for daemon-driven runs comes later.
- **Run dir auto-cleaned on success**. On failure, the run dir is currently still removed (the implementation always cleans up). Open: keep failed run dirs for debugging? Phase 3+ decision.
- **DITHER_PLUGIN_NAME, DITHER_RUN_DIR, DITHER_INPUT_FILE, DITHER_STATE_FILE, DITHER_TRIGGER** are always granted via `--allow-env`. Plugin-declared `host_env` adds to that list.
- **Manifest schema lives in `apps/cli/src/manifest.ts`** (zod). The SDK does not validate the manifest — the host does. Plugins don't need to depend on zod.

### Inputs / files flow (added during option B)

- **`installPlugin(opts)` is the canonical surface** for grant-bearing install. Programmatic API accepts `inputs: Record<string, string|number|boolean>` and `files: Record<string, string>` (absolute or relative paths). Validation runs _before_ any disk writes, so missing-required failures roll back cleanly.
- **CLI flags use comma-separated KEY=VALUE pairs**: `--input "K=V,K2=V2"`, `--file "K=/abs/path"`. Repeated flags would be cleaner but citty doesn't natively support arrays without manual parsing — comma-separated is the smallest readable surface. Open: switch to repeated flags or JSON when interactive prompts arrive (phase 3).
- **Coercion at install**: `kind: number` parses string → number; `kind: bool` parses `"true"`/`"1"`/`1` → true. `kind: string`/`secret` are stored as strings. Coercion fails are surfaced as `NaN`/etc. — improving error messages is parked.
- **Secrets are stored plaintext in `grants/<name>.json` for v1**. The architecture commits to OS keychain (macOS Keychain via `security`, libsecret on linux) — that's deferred to phase 3 with the interactive install prompt. Documented as a known security gap; the local-first stance still holds (file is on the user's machine, scoped by Unix file perms), but production-quality keychain handling is needed before any release.
- **`input.json` shape at run**: `{ trigger, config, secrets, files, targets }`. `config` carries non-secret declared inputs; `secrets` carries declared `kind: secret`; `files` carries absolute paths from grants. The host adds each file/folder path to Deno's `--allow-read` flag automatically — plugin authors don't think about Deno permissions for declared files.
- **Required-input rule**: an input is required iff its manifest declaration has no `default`. Both secrets and non-secrets follow this rule. There is no separate `required: true` flag on inputs (unlike `files`).
- **Required-file rule**: a file input is required iff `required: true` in the manifest. Default file paths don't make sense (paths are user-specific), so there's no equivalent of input `default` for files.
- **File kind validation**: `kind: file` requires a regular file at that path; `kind: folder` requires a directory. Mismatches throw at install.

### API key defaults

- **Capability default**: `read-only`. Mutations (`entry.create`, `plugin.run`) require explicit `--read-write`.
- **Collection scope default**: absent = all (within capability).
- **Expiry default**: never (until revoked). Optional via `--expires`.

### Tooling versions (resolved against the npm registry's "before" cutoff active at install time)

| dep           | version          | reason                                                                        |
| ------------- | ---------------- | ----------------------------------------------------------------------------- |
| `oxlint`      | ^1.0.0 → 1.61.x  | Latest 1.x — major coverage stable.                                           |
| `oxfmt`       | ^0.45.0 → 0.45.x | 0.46.0 was published after the registry cutoff; 0.45 is the latest available. |
| `tsdown`      | ^0.21.0 → 0.21.x | Latest available before cutoff.                                               |
| `typescript`  | ^6.0.0 → 6.0.x   | Major version 6 was current.                                                  |
| `vitest`      | ^4.0.0 → 4.x     | Latest major.                                                                 |
| `citty`       | ^0.2.0 → 0.2.x   | Latest major.                                                                 |
| `@types/node` | ^22.0.0          | Pinned to Node 22 minor stream to match runtime target.                       |

### TypeScript config

- `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`.
- `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`.
- `exactOptionalPropertyTypes: false` (dropped during phase 1) — third-party libraries with `prop?: T` types don't distinguish "missing" from "explicitly undefined", and propagating spread-conditional patterns through every API call site adds noise without measurable safety. `strict` already gives us the meaningful checks. Override: re-enable in `tsconfig.base.json` if a real bug surfaces.
- Imports omit extensions (`./main`, not `./main.ts` or `./main.js`) — works with bundler resolution; tsdown bundles to `.mjs`.

### Build outputs

- tsdown emits `.mjs` (its default for ESM). `package.json` `bin`/`main`/`exports` updated to point at `.mjs`/`.d.mts`.

### Test layout

- Test files colocated with source: `src/**/*.test.ts`. (Alternative: separate `test/` tree — rejected for ergonomics.)
- Vitest config minimal; no setup files in v1.

### Repo / monorepo

- npm workspaces with `apps/*`, `packages/*`, `packages/plugins/*` globs.
- Root `package.json` is `private: true`; per-package versions independent.
- License: MIT (asked, confirmed by user).

---

## Things that should escalate to the user if they recur

Patterns where I made a low-stakes guess but a user-level call exists. If we hit one of these in a phase, ask before deciding.

- **OS-native paths vs. dotfile** — currently `~/.dither/`; XDG / Library / APPDATA path scheme is a real choice for v2.
- **Telemetry beyond install pings** — I'm assuming "no" for everything. If we ever want crash reports, that's a user-facing decision.
- **Bundling vs. external deps in published binary** — currently external (smaller npm install footprint, more startup time).
- **Markdown frontmatter strictness** — I assumed gray-matter's default (YAML, permissive). TOML / strict schema is a future call.
- **Time-sensitive dep pinning** — picked latest-available-before-cutoff. Could pin tighter for reproducibility (lockfile already does most of this).

---

## Defaults the user explicitly affirmed (moved here for the record; can be promoted to architecture.md if useful)

- npm package name `dither` is owned by the user (verified).
- Repo structure: monorepo for public, separate for private.
- No prettier — `oxfmt`.
- No logger lib — plain `console.*`.
- No pnpm — npm.
- License — MIT.
