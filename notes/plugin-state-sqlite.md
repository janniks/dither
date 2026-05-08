---
status: thinking
priority: P1
---

# Plugin SDK: `openStateDb()` for record-shaped state

## Problem

The SDK's persistent state model today is `readState/writeState`: load a JSON
blob into memory, mutate, write the blob back as a whole file. That's correct
for small mutable preambles ("schema_version", "last_run_at", iMessage's
two-pointer cursor). It's the wrong shape once a plugin holds a *table* of
records.

URL scraper is the first plugin to hit this. Its cache keys URLs to status
metadata. Back-of-envelope at 300 bytes per row:

| URLs | state.json size | rewrite cost per run |
|---|---|---|
| 1k | ~300 KB | trivial |
| 10k | ~3 MB | ~30ms |
| 100k | ~30 MB | ~300–500ms |
| 1M | ~300 MB | seconds + Dropbox/iCloud sync hell |

A heavy Twitter library has 10–50k likes; iMessage has 100k+ rows. 100k
URLs in the cache is realistic. Whole-file rewrite, no atomicity, no
indexes, no partial reads — every dimension is wrong at scale.

## Decision

Add a new SDK function (lazy, opt-in by use):

```ts
import { openStateDb } from "@dither/plugin";

const db = openStateDb();           // first call creates state.sqlite
db.exec(`CREATE TABLE IF NOT EXISTS scrapes (...)`);
db.prepare("SELECT * FROM scrapes WHERE source_url = ?").get(url);
```

- **Implementation**: `node:sqlite` (Node 22+, present in Deno's Node compat).
  `DatabaseSync` instance — sync API, fast, no `await` clutter at call sites.
  No npm install, no FFI grant.
- **File**: `<home>/plugins/<name>/state/state.sqlite` next to `state.json`.
  WAL: `state.sqlite-wal`, `state.sqlite-shm` siblings. All under the
  existing `--allow-write=stateDir` grant.
- **Lazy**: file only created on first `openStateDb()` call. Plugins that
  don't import it carry no overhead.
- **Plugin owns its schema**: `CREATE TABLE IF NOT EXISTS` at the top of
  `plugin.ts`. SDK provides no migration helpers; plugin authors do their
  own `schema_version` row + DDL if they need to evolve.
- **No `compact()`, no `vacuum()`, no `close()` SDK function.** Plugin runs
  end and the process exits — that closes the handle. WAL gets checkpointed
  on next open. Out-of-band compaction (`VACUUM`) is a manual `sqlite3 cli`
  thing if it ever matters.

## Naming

`openStateDb()`:
- Single verb (`open`), matches sqlite idiom (`new Database()`, `db.open()`),
  parallels SDK style (`readInput`, `readFile`, `readState`, `writeState`,
  `writeEntry`, `progress` — all single-verb, no `get-` prefix).
- "State" makes it clear it's for plugin-owned data, parallel to
  `state.json` (vs e.g. opening a foreign sqlite like iMessage's chat.db).
- "Db" disambiguates from the JSON state functions.

Considered and rejected: `getStateDb()` (no `get-` prefix in this SDK),
`db()` (too terse — first call does real work, "open" reflects that),
`openState()` (collides with `readState`/`writeState`), `storage()` (too
generic).

## Why not `sql.js`?

`sql.js` is pure WASM and lives in-memory. Used today by the iMessage plugin
*to read foreign sqlite databases* (Apple's chat.db) without holding a write
lock. Right tool for that job.

Wrong for plugin-owned state: WASM in-memory means persistence is via
manual `db.export()` → write whole bytes back. Same anti-pattern as JSON
whole-rewrite, just binary. Also no transactions, no WAL crash safety.

The two coexist cleanly: imessage keeps `npm:sql.js` for chat.db; new
plugins use `openStateDb()` for their own DB.

## Why not `better-sqlite3` or `@db/sqlite`?

Both require `--allow-ffi` (one ships a `.node` native binding, the other
uses `Deno.dlopen`). FFI is a no-go for plugins (see
`notes/sandbox-ffi-policy.md`). `node:sqlite` is runtime-provided — the
plugin's Deno gets the JS API without exposing the FFI capability.

## Two-tier state is fine

`state.json` doesn't go away. Plugins that only need a small preamble keep
using JSON. Plugins with record-shaped data add `state.sqlite` alongside.
A plugin can use both:

- `state.json` → "last run at, schema version, head_rowid cursor".
- `state.sqlite` → "10k rows of cached URL fetches".

## url-scraper's schema if we ported it

```sql
CREATE TABLE IF NOT EXISTS scrapes (
  source_url  TEXT PRIMARY KEY,
  fetched_at  TEXT NOT NULL,
  status      INTEGER NOT NULL,
  final_url   TEXT,
  skipped     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_skipped ON scrapes(skipped) WHERE skipped = 1;
CREATE INDEX IF NOT EXISTS idx_4xx     ON scrapes(status)  WHERE status >= 400 AND status < 500;
```

Per-URL operations:

- `decide(url)`: `SELECT skipped, status FROM scrapes WHERE source_url = ?` —
  one prepared statement, microseconds, no full-table scan.
- `record(url, entry)`: `INSERT … ON CONFLICT(source_url) DO UPDATE …` —
  microseconds.
- Future "list permanent failures": `SELECT * FROM scrapes WHERE skipped = 1
  OR (status >= 400 AND status < 500)` — index-driven.

WAL gives crash safety mid-run. No "everything since the last save_at()
is lost on plugin crash" problem.

## Caveats

- **Backups**: `state.sqlite` is binary, doesn't merge across machines via
  Dropbox/iCloud. For url-scraper that's actually fine — the cache is
  rebuildable by re-running. If a plugin needs syncable state, keep it in
  `state.json`.
- **Inspection**: `cat state.json` doesn't work for sqlite. `sqlite3
  state.sqlite ".dump"` does. Marginal cost.
- **`node:sqlite` sandbox check**: should be clean (runtime built-in, no env
  probes), but verify by smoke test before assuming. The pattern of
  every-import-time-env-probe-bites-us suggests we should always check.

## Out of scope

- KV API (`kv.get`/`kv.set`) on top of sqlite. Tempting but the moment a
  plugin wants `iter(WHERE skipped = 1)` it becomes a worse SQL.
- Schema-in-manifest declarations. Plugin code owns DDL.
- Auto-migrations.
- `dither plugin compact <name>` CLI. Not needed; sqlite WAL is fine for
  per-plugin scales.

## Next

1. Smoke-test `node:sqlite` under the plugin sandbox (does it import without
   env-probe surprises? does WAL work under stateDir's `--allow-write`?).
2. Ship `openStateDb()` in `@dither/plugin`.
3. Once landed, port url-scraper's `cache.ts` to it as the first user.
