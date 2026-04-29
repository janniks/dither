# Review — 2026-04-29 (post option C)

> Multi-agent code review (`/review-all`) run after phases 0–2 + options A/B/C. No fixes applied — this document is the snapshot to act on later.

## State at review time

- 26 source TS files, ~2k LOC.
- **32 tests passing**, all gates green (typecheck, oxlint, oxfmt, build).
- Repo is fresh — nothing committed beyond the empty initial. All code is from this session.
- Phases done: 0 (scaffold), 1 (search + get), 2 (plugin install + run), opt A (pipeline + reindex), opt B (inputs + files flow), opt C (list/remove/status).

## Reviewers run

| reviewer | status | notes |
|---|---|---|
| composto (IR) | ✓ | confirmed `runPlugin` has no callers outside the diff |
| codebase-pattern-finder | ✓ | found duplication: frontmatter parsing, env-var lists, mkdir/exists boilerplate, test scaffolding (×10), arg coercers |
| codex-style strict review | ✓ | 45 numbered findings (substituted general-purpose agent — codex agent type not available in session) |
| codex-style roast | ✓ | extra embarrassments — substituted general-purpose agent |
| simplify sub-agents (reuse / quality / efficiency) | **not run** | most overlap already covered above; efficiency axis partially missed |

## Findings — deduped, by severity

### Must-fix — correctness, data loss, security

| # | location | issue |
|---|---|---|
| M1 | `apps/cli/src/plugin-run.ts:184-186` | promote does blind `copyFile` over destination. A plugin emitting `auth.md` clobbers user's hand-authored `entries/notes/auth.md`. No "this entry was sourced by plugin X" check on the destination. |
| M2 | `apps/cli/src/plugin-run.ts:161-189` | partial-promote on failure: throwing mid-loop leaves files already moved into `entries/`, and `rm` of `runDir` at line 189 is unreachable on throw. Both leaked run dirs and a partially-promoted index. Validate-all-then-copy. |
| M3 | `apps/cli/src/plugin-run.ts:123-124` | `--allow-read` joins paths with `,` — Deno's separator. User file path containing a comma silently splits into bogus allow entries. Same for `allowWrite`. |
| M4 | `apps/cli/src/plugin-run.ts:91-93` + `apps/cli/src/plugin-install.ts:104-108` | plugin state lives at `pluginDir/state/`. Reinstall does `rm -rf destDir` → state wiped. State must live outside `pluginDir`. |
| M5 | `apps/cli/src/plugin-run.ts:29-48` | `extractCollection`/`extractSource` regex is wrong for any frontmatter value containing escaped quotes. SDK emits `JSON.stringify` so `foo"bar` becomes `"foo\"bar"`; regex captures `foo\` and quote-strip is a no-op. Source/collection comparison silently fails. Replace with a real YAML parser shared with the SDK write side. |
| M6 | `packages/plugin/src/index.ts:67-71` | `id` from user frontmatter trusted blindly; `filename: "../../etc/passwd.md"` escapes `runDir` because `join(runDir, baseName)` doesn't reject `..`. Path-traversal in the SDK. |
| M7 | `apps/cli/src/plugin-install.ts:67-78` | `resolveFiles` uses `stat` (follows symlinks). User grants `~/Documents`; later it's a symlink to `/`. Plugin gets `--allow-read=/`. Use `lstat` or store realpath. |
| M8 | `apps/cli/src/plugin-install.ts:104-108` | reinstall is non-atomic: `rm -rf destDir` → `mkdir` → `cp -r`. If `cp` fails midway, plugin is wiped. Tmpdir-then-rename. |
| M9 | `apps/cli/src/manifest.ts:20` | `host_net: z.array(z.string())` with no refinement. `host_net: [""]` or `["*"]` passes through to Deno; `--allow-net=` (empty) means *everything*. |
| M10 | `apps/cli/src/plugin-run.ts:113-121` | `import.meta.resolve` returns `file://` URL passed to import map; `fileURLToPath(sdkUrl)` for `--allow-read` doesn't handle symlinked workspaces (npm hoisting can put symlink and target in different paths; Deno needs both). |

### Should-fix — UX, validation, atomicity

| # | location | issue |
|---|---|---|
| S1 | `apps/cli/src/plugin-run.ts:149-156` | no signal handling: parent SIGINT doesn't kill spawned `deno`; runDir leaks. No timeout — runaway plugin runs forever. |
| S2 | `apps/cli/src/plugin-run.ts:150` | spawning `deno` with no `which` check. Missing → opaque `ENOENT` stack trace, not "Deno required; install from https://deno.com". |
| S3 | `apps/cli/src/manifest.ts:31-32` | `auto_create` schema field is unused — `runPlugin` only honors `collections.writes`. Either implement or remove. |
| S4 | `apps/cli/src/manifest.ts:22-26` | `Permissions.browser` declared in schema but never enforced anywhere. Speculative abstraction. Remove until phase 7 (browser sidecar) lands. |
| S5 | `apps/cli/src/manifest.ts:46-47` | no duplicate-`id` check in `inputs[]` / `files[]`. Two with same id silently overwrite via the for-loop. Add `.refine`. |
| S6 | `apps/cli/src/manifest.ts:4,12` | input/file `id` is `z.string()` with no charset constraint. `id: ""`, `id: "a b c"`, `id: "../../etc"` all parse. Restrict to `/^[A-Z_][A-Z0-9_]*$/` or similar. |
| S7 | `apps/cli/src/plugin-install.ts:24-26` | `coerceInput` for `kind: "number"` returns `NaN` for `"abc"`. No `Number.isFinite` check. |
| S8 | `apps/cli/src/plugin-install.ts:31` | `--input=API_TOKEN=` (empty value) silently stored as empty secret, no error. |
| S9 | `apps/cli/src/commands/plugin.ts:11-15` | `parsePairs` silently drops malformed input (e.g. `--input=foo` with no `=`). User has no idea it was dropped. |
| S10 | `apps/cli/src/commands/plugin.ts:10` | `parsePairs` splits values on `,` with no escaping. Secret containing comma → silently truncated. Switch to repeated flags or JSON. |
| S11 | `apps/cli/src/commands/plugin.ts:41` | `parsePairs(args.input) as Record<string, InputValue>` — cast lies. Returns `Record<string, string>`; numeric/bool typed inputs get string-coerced through the wrong path. |
| S12 | `apps/cli/src/search.ts:38-43` | lex returns `r.collectionName`; hybrid returns `r.context ?? ""`. Two different qmd fields, both called `collection` in our public type. Hybrid result lies about its collection. |
| S13 | `apps/cli/src/commands/search.ts:35` | `parseInt(args.limit, 10)` without `isFinite` check. NaN reaches qmd. |
| S14 | `apps/cli/src/commands/get.ts:9-13` | `parseLineRange` silently accepts inverted ranges (`--lines=10:5`) and zeroes via `Math.max`. User gets empty content with no error. |
| S15 | `apps/cli/src/status.ts:35` | `countMarkdownDeep` explodes on permission-denied subdirs (EACCES propagates as stack trace from `dither status`). |
| S16 | `apps/cli/src/status.ts:38` | `countMarkdownDeep` follows symlinks; loop → infinite recursion → stack overflow. |
| S17 | `apps/cli/src/status.ts:35-43` | serial `await stat`/recursion. Use `readdir(dir, { withFileTypes: true })` + `Promise.all`. |
| S18 | `apps/cli/src/update-index.ts:23-27` | `?? 0` masks a buggy qmd returning `undefined` for `indexed`. Hides a real bug rather than failing. |

### Nice-to-have — quality, dedup, naming

| # | location | issue |
|---|---|---|
| N1 | `apps/cli/src/plugin-run.ts:21-27` + `packages/plugin/src/index.ts:52,64-65,89,97` + SDK doc comment lines 5-13 | env var names listed in **3** places. Extract one shared const, e.g. `packages/plugin/src/env-names.ts`. |
| N2 | 10× test files | `mkdtempSync` + `DITHER_HOME` swap + `afterEach` cleanup repeated. Extract `useTempHome()` helper. Sites: `get.test.ts:8-24`, `inputs.test.ts:11-26`, `cli-dispatch.test.ts:29-44`, `pipeline.test.ts:10-25`, `lifecycle.test.ts:11-26 and 76-91`, `plugin-host.test.ts:18-32`, `search.test.ts:8-22`, `update-index.test.ts:8-22`. |
| N3 | `plugin-host.test.ts:59,73,113` | secondary `mkdtempSync` for plugin source dirs lacks `afterEach` cleanup → temp dir leak in tests. |
| N4 | 7+ sites | `mkdir({recursive:true})` and `existsSync ? rm` boilerplate everywhere. `ensureDir` / `rmIfExists` worth extracting (probably in `home.ts`). |
| N5 | `commands/plugin.ts:7-18`, `commands/get.ts:4-13`, `commands/search.ts:35` | three different inline arg coercers. Move to `commands/_args.ts`. |
| N6 | `apps/cli/src/plugin-run.ts` | error messages drift inside one file (capitalized vs lowercase, with/without periods, quoted vs unquoted identifiers). Pick one convention and document. |
| N7 | `apps/cli/src/search.ts:59-61` | empty `try { … } finally { /* comment */ }`. Dead code with apologetic comment. Just delete the `try`. |
| N8 | `packages/plugin/src/index.ts:60-64` | function named `yamlValue` whose body is `return JSON.stringify(v)`. Rename or replace with a real YAML emitter. |
| N9 | `apps/cli/src/get.ts:18-22` | `Math.max(0, opts.toLine - fromLine + 1)` defends against impossible-case (CLI clamps right before). Trust internal callers. |
| N10 | `apps/cli/src/main.test.ts` | tests citty's `defineCommand` returning the strings you put into it. Tests the framework, not the code. Delete or replace with a CLI smoke. |
| N11 | `architecture.md:39` ASCII diagram | wasn't reflowed after the rename — `dither daemon` text in a box sized for `openindex daemon`; right edge ragged. |
| N12 | `apps/cli/src/plugin-list.ts:35` | `file.slice(0, -".json".length)` — bizarre way to write `-5` or `replace(/\.json$/, "")`. |
| N13 | `llm-decisions.md` entries | several "decisions" describe behavior, not decisions (e.g., "tests use lex mode" is gravity, not a choice). Trim. |

## Recommended cut

**Before any release / publish:**
- M1, M2, M4 (data-loss on promote / state wipe on reinstall)
- M5 (broken frontmatter parser)
- M6 (SDK path traversal)
- M7 (symlink follow in file grants)
- M9 (host_net wildcard means anything)

**Before "v0 alpha" tag:**
- All Should-fix items
- N1, N2, N4, N5 (the four highest-leverage dedup wins)

**Defer to a refactor pass:**
- Remaining nice-to-haves

## Suggested next-phase ordering

1. **Phase 2.5 — security & correctness fixes.** Walk the must-fix list; close M1–M10. Add tests for each (path traversal, comma-in-path, etc.).
2. **Phase 2.6 — should-fix sweep.** Validation tightening (S5, S6, S7, S8, S13, S14), error UX (S2, S15, S16), schema cleanup (S3, S4).
3. **Phase 2.7 — refactor pass.** N1–N5: shared env-name const, `useTempHome()` helper, `ensureDir`/`rmIfExists`, `commands/_args.ts`. No new features.
4. **Then phase 4 (daemon).** As planned.

## Reviewer caveats

- The codex review and roast were run via the `general-purpose` agent because the `codex:codex-rescue` agent type isn't present in this session. The findings are still substantive but not produced by GPT-5.4 / high-effort as the `/review-all` skill specifies.
- The simplify skill's reuse/quality/efficiency sub-agents were loaded but never launched. Running them later would mostly re-confirm the dedup material; the genuine new signal would come on the **efficiency** axis (only `status.ts` got serial-vs-parallel scrutiny here).

## Addendum — surfaced while writing the docs site (same day)

Three subagents writing user-facing docs read the source and surfaced a few additional sharp edges not in the main table. Recording for future fixing:

| # | location | issue |
|---|---|---|
| A1 | `packages/cli/src/commands/search.ts:35-36` | `--mode` silently coerces unknown strings (typos like `"hybrid "` or `"lexical"`) to `undefined` → falls back to default. Should error. |
| A2 | `packages/cli/src/commands/get.ts` + `packages/cli/src/get.ts` | `getDocumentBody` returning `null` causes the CLI to print nothing and exit 0. No way to distinguish "file empty" from "doesn't exist" at the shell. Add `--strict` or differentiate exit codes. |
| A3 | `packages/cli/src/plugin-run.ts:189` | `await rm(runDir, …)` only runs on success — both plugin-process failure and promote-validation failure leak the run dir. Worse: `runs/<id>/input.json` contains plaintext secrets, so failed runs leave them on disk indefinitely. Wrap in `try/finally`. |
| A4 | `packages/cli/src/commands/plugin.ts` (list output) | Shows a `schedule` column for a feature that doesn't run yet (no daemon). Either hide until phase 4 or render as `—`/`manual only`. |
| A5 | `packages/plugin/src/index.ts` `writeEntry` | Silent overwrite on filename collision within a single run. Two `writeEntry` calls with the same `frontmatter.id` (or same `filename`) → second clobbers first; only one entry ever promoted. No warning. |
| A6 | `packages/plugin/src/index.ts` `writeState` | Full overwrite, no merge. A plugin reading partial state and writing a partial update silently loses every key it didn't include. Plugin authors won't expect this from the API shape. |
| A7 | `packages/plugin/src/index.ts` `readState` | Returns `null` for both "file missing" and "file empty after trim". Authors who differentiate "first run" from "corrupted state" can't. Either write an empty object on first init, or expose a separate "first-run?" predicate. |
| A8 | `packages/cli/src/manifest.ts` `auto_create` field | Doubly inert: not enforced anywhere AND not needed — `runPlugin` already calls `mkdir(destDir, { recursive: true })` in the promote loop, so collections in `writes` are auto-created today regardless. Either remove the schema field or repurpose it. (Was already flagged as S3; this is the explanation of *why* it's safe to remove.) |
| A9 | `packages/cli/src/manifest.ts` `FileDef.extensions` | Schema field exists; `resolveFiles` never reads it. A `.txt` file passes for a manifest that declares `["md"]`. Either enforce or remove. |
| A10 | `packages/cli/src/home.ts:resolveHome` | No validation of `DITHER_HOME`. Empty string, `"/"`, or any nonsense string is silently propagated into `--allow-read` / `--allow-write` flags fed to Deno. Validate at startup: must be absolute, must not be `/`, must be creatable. |
| A11 | `packages/cli/src/main.ts` and citty subcommands | citty's auto-generated `--help` is fine, but several `description` fields are anemic (e.g. `dither get`'s ref description doesn't mention `--lines`). Polish. |
| A12 | first-run UX | `dither search` (default `--mode hybrid`) silently downloads ~1–2 GB of qmd models on first invocation with no progress indicator from our side. User sees a long pause. Surface the download in our wrapper. |

Severity recap: **A3** is the only addition that's must-fix territory (secret leakage on failed runs). A1, A2, A6, A7, A10 are should-fix. The rest are nice-to-have polish.

## How to act on this file

- Treat each finding as a checkbox to tick when fixed.
- When closing a must-fix or should-fix item, add a one-line note next to the row (date + brief explanation).
- When this report is fully drained, archive it (rename with `-ARCHIVED.md`) so future reviews are diffable against a known baseline.
