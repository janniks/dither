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
- **Collection ACL enforced at promote**: every output file's `collection:` frontmatter is checked against the plugin's granted `collections`. Mismatches throw and the entire run fails (no partial promote). v0 is fail-closed; partial-promote with per-file errors is a v2 ergonomics question.
- **Install is idempotent**: `dither plugin install <path>` replaces an existing install for that name. No merge, no version bookkeeping in v0; phase 3 will add the explicit-update flow.
- **Plugin runs use stdio: "inherit"** — plugin stdout/stderr go straight to the user's terminal. Captured-log mode for daemon-driven runs comes later.
- **Run dir auto-cleaned on success**. On failure, the run dir is currently still removed (the implementation always cleans up). Open: keep failed run dirs for debugging? Phase 3+ decision.
- **DITHER_PLUGIN_NAME, DITHER_RUN_DIR, DITHER_INPUT_FILE, DITHER_STATE_FILE, DITHER_TRIGGER** are always (and only) on Deno's `--allow-env` list. Plugin code never reads host env vars directly — env values flow through `input.env`, sourced from grants and the dither global env store.
- **Manifest schema lives in `packages/cli/src/manifest.ts`** (zod). The SDK does not validate the manifest — the host does. Plugins don't need to depend on zod.

### Grants flow (rewrote 2026-04-30; supersedes the inputs/files entry below)

- **`installPlugin(opts)` is the canonical surface** for grant-bearing install. Programmatic API accepts `{ source, env, envRefs, files, net, collections }`. Validation runs _before_ any disk writes, so missing-required failures roll back cleanly.
- **CLI flags use comma-separated KEY=VALUE pairs (or KEY,KEY2 for list-shaped grants)**: `--env "K=V,K2=V2"`, `--allow-env "K1,K2"`, `--file "K=/abs/path"`, `--allow-net "h1,h2"`, `--allow-collection "c1,c2"`. Repeated flags would be cleaner but citty doesn't natively support arrays without manual parsing — comma-separated is the smallest readable surface. Open: switch to repeated flags or JSON when interactive prompts arrive (phase 3).
- **`run` mirrors `install`**. The same flag surface applies, with two semantics depending on the positional:
  - `run <path>` → install (or reinstall) with the flags as **persisted** grants, then run.
  - `run <name>` → run an installed plugin with the flags as **ephemeral per-run overrides** layered on top of grants. Grants on disk are not mutated.
- **Env values are strings, end of story**. No `kind`, no `secret` flag — privacy is the user's call. A plugin author who needs a number coerces in code (`Number(input.env.MAX_RUNS)`).
- **Env values stored plaintext in `grants/<name>.json` and `~/.dither/env.json` for v0.** The architecture commits to OS keychain (macOS Keychain via `security`, libsecret on linux) — that's deferred to a later phase with the interactive install prompt. Local-first stance still holds (files are on the user's machine, scoped by Unix file perms), but production-quality secret handling is needed before any release.
- **`input.json` shape at run**: `{ trigger, env, files, targets }`. `env` carries every grant-resolved value (literal grants, then global lookups for `envRefs`, then manifest defaults); `files` carries absolute paths. Host adds each file/folder path to Deno's `--allow-read` automatically.
- **Required-env rule**: an env is required iff its manifest declaration has no `default` AND the user didn't grant a literal value or a global ref. Install fails with `Required env '<name>' was not provided…`.
- **Required-file rule**: a file input is required iff `required: true` in the manifest.
- **File kind validation**: `kind: file` requires a regular file at that path; `kind: folder` requires a directory.
- **Default-grant-from-manifest**: at install, if the user passes no `--allow-net` flag, all manifest-declared net hosts are granted. Same for `--allow-collection`. The manifest is the install-time _default_ when the flag is omitted — it is **not** a ceiling. A `--allow-collection` or `--allow-net` flag can grant values the manifest didn't declare; the grants file is the source of truth at promote.
- **Collection grants are globs**: `--allow-collection messages/**` (descendants), `messages/*` (direct children), `messages` (exact). Frontmatter `collection` may be a nested path; promote validates the path (no `..`, no leading/trailing `/`, no `.md` suffix) and matches against the grant glob set via picomatch (`packages/cli/src/collection-paths.ts`).
- **Reference, not copy** for global env. A plugin granted `--allow-env OPENAI_API_KEY` reads the current value from `~/.dither/env.json` at every run. Rotate the global once via `dither env set`, every plugin sees the new value next run.

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
