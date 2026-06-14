# qmd 2.1.0 → 2.5.1 — update run-down

> Read-only research. No code touched yet. Today: 2026-05-22.

## Versions

- **Installed**: `@tobilu/qmd@2.1.0` (declared `^2.1.0`, packages/cli/package.json:24)
- **Latest**: `2.5.1` (published 2026-05-20)
- **Skipped**: 2.5.0 (2026-05-19) — superseded one day later by 2.5.1

No major bump. Caret would already accept 2.5.1 — only the lockfile holds us back.

## Blocker: min-release-age

`~/.npmrc` enforces `min-release-age=7`. 2.5.1 is **2 days old**. `npm install`
will refuse it until **2026-05-27**. 2.5.0 (3 days old) is also under the floor.

We can do the planning/dry-edits today and schedule the actual lockfile bump for
2026-05-27 (or later — landing on the weekend is fine).

## Our surface area (what dither calls)

Only three imports in `packages/cli/src/`:

- `store.ts:3` — `createStore`, `QMDStore`, `Collection`
- `search.ts:1` — `extractSnippet`
- `progress.ts:83/100` — comments only

Public API methods we use, from `store.ts` + `search.ts`:

- `createStore({ dbPath, config: { collections } })`
- `store.search({ query, limit, collection, rerank })`
- `store.searchLex(query, { limit, collection })`
- `store.getDocumentBody(docid)`
- `extractSnippet(body, query, undefined, chunkPos, chunkLen)`

That's it. No `embed`, `update`, `getStatus`, `addCollection` etc. — those are
exposed by qmd but dither doesn't drive them.

## Changes in 2.5.x that touch us

### Likely behaviour-affecting (worth verifying)

- **`extractSnippet` returns absolute source-file line numbers** (changelog: "Snippet line numbers… `qmd_query` (MCP), HTTP `/query`, and `qmd query` (CLI JSON output and snippet headers) now return absolute source-file line numbers instead of chunk-local ones"). Our search.ts:111-113 does `lines[s.line - 1]?.trim()` where `lines = body.split("\n")` — i.e. we already index into the full body. If the old behaviour was chunk-local, our preview line could have been *wrong* whenever `chunkPos > 0`. **Net effect: 2.5.1 likely fixes a latent bug in `safeSnippet`.** Worth re-reading the new TS signature on bump.

- **`handelize()` case preservation + auto-migration on `qmd update`**. We don't call `update()`, so we won't trigger the migration. But: any document docids we've stored in dither state that were lowercased by old qmd will keep working (qmd handles the legacy form). Non-issue unless we move to driving `update()` ourselves.

- **Embedding completeness rule**: docs only count as embedded once *all* chunks are covered. Affects `getStatus()` pending counts — we don't read those, so no impact today, but worth knowing if status is ever surfaced.

- **Vec table lazy migration on first vector-health/write use**: any existing dither user's SQLite store gets quietly migrated when search hits the vec path. Should be transparent. Smoke-test with a real existing library before merging.

### Newly available, not adopted

- `addLineNumbers` — could replace some of our own line-number formatting in previews, but not urgent.
- `Maintenance` export — for vacuum/repair ops; not in scope.
- `getDefaultDbPath` — we own our own path via `indexDbPath()`, n/a.
- `qmd doctor` (CLI only) — could be mentioned in our troubleshooting docs but no code change.

### No impact

- `qmd doctor`, `qmd skills list|get|path`, `qmd skill install` — CLI commands, not SDK.
- Trusted-publishing migration (2.5.1) — supply-chain meta, not API.
- GPU env vars (`QMD_FORCE_CPU`, `QMD_LLAMA_GPU`, `QMD_STATUS_DEVICE_PROBE`) — opt-in; if users hit GPU issues they can set them, but we don't have to plumb them.
- AST chunking via `web-tree-sitter` — qmd-internal; affects index quality not our API.
- `models:` section in `index.yml` — we read index.yml in `qmd-import.ts` for *collection* discovery only (init flow). We deliberately ignore models per `specs/init-adopt-qmd.md` "What we read". Stays out of scope.

## Plan shape (when we bump)

1. Bump `packages/cli/package.json` `^2.1.0` → `^2.5.1`.
2. `npm install` from repo root → updates root `package-lock.json` only.
3. Native deps: changelog mentions `better-sqlite3` update inside qmd's tree. With `ignore-scripts=true`, run `npm run install` inside `packages/cli/node_modules/@tobilu/qmd/node_modules/better-sqlite3` if `dither search` fails with a missing-binding error. (Per AGENTS.md.)
4. Re-check `extractSnippet` signature in the new `.d.ts` — the call in search.ts:111 currently passes 5 args (`body, query, undefined, chunkPos, chunkLen`); verify shape didn't change.
5. Smoke: `dither search "..." --preview` against an existing library, confirm snippet `text` matches the printed `line`. Bonus: pick a doc where the match is in chunk N>0 — that's where the old line-number bug would have shown up.
6. Run the cli test suite (`npm test -w packages/cli`).
7. Commit as `chore(deps): bump @tobilu/qmd 2.1.0 → 2.5.1`.

No spec/plan needed — single-version bump with no API rename. If smoke surfaces
the snippet-line fix as a *visible* behaviour change, mention it in the commit
body so future-you doesn't bisect for it.

## Open questions

- None blocking. The bump is mechanical; the only thing to actually verify is
  that `extractSnippet`'s new absolute-line return doesn't double-count against
  our `body.split("\n")[s.line - 1]` indexing (it shouldn't — they're both
  whole-body line numbers now).
