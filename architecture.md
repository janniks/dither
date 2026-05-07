# dither — architecture

> Living document. Decisions captured as they're made; open questions tracked at the bottom.

## What it is

**dither** is a personal index for the agentic era. It sits between the world (email, calendar, browser, repos, notes, photos, …) and your agents. It ingests, augments, and serves your personal corpus to whatever LLM-driven workflow you point at it.

It is the conceptual successor to **mmry.io** (private, local-first personal search), redesigned around two assumptions that did not exist when mmry was first sketched:

1. The primary _consumer_ of a personal index is no longer a human typing into a search box — it is an agent loop calling a tool.
2. Local LLMs and embedding models are now good enough to do meaningful retrieval and enrichment on-device.

## Design north star: simple made easy

Borrowing Hickey's distinction. We refuse to _complect_ (entangle):

- storage with search
- search with ingestion
- ingestion with enrichment
- the daemon with the CLI
- plugin code with plugin permissions
- agent identity with user identity

Each concern lives behind a narrow interface and can be replaced. The user can hand-edit the underlying markdown with `vim` and the system still works. No magic schemas, no hidden state.

There is **no ownership concept**. There are just folders and files. The security model is access, not ownership: a plugin is granted read/write on certain folders, period.

## The shape

```
┌────────────────────────────────────────────────────────────────┐
│ user (CLI)             plugin (Deno)            agent (MCP/CLI)│
│ full access            sandboxed, file-based    API-key-scoped │
└────────┬──────────────────────┬─────────────────────────┬──────┘
         │ unix socket          │ stdin + run dir         │ socket / http
         │                      │                         │
┌────────▼──────────────────────▼─────────────────────────▼──────┐
│  dither daemon                                                     │
│   ├─ scheduler / file watchers                                 │
│   ├─ plugin host (spawns Deno with derived flags)              │
│   ├─ run-dir promoter (validates output, moves to library)     │
│   ├─ MCP server (local; hosted later)                          │
│   └─ qmd handle (in-process via @tobilu/qmd SDK)               │
└────────────────────────────┬───────────────────────────────────┘
                             │ writes/reads markdown
┌────────────────────────────▼───────────────────────────────────┐
│  <library>/<collection>/**/*.md           ← canonical store │
│  qmd index (~/.cache/qmd/index.sqlite)       ← derived         │
└────────────────────────────────────────────────────────────────┘
```

**dither never invents its own search.** Search is qmd. We embed qmd as a library (`@tobilu/qmd`) for in-process queries. We expose a curated subset as the default; raw access available via `dither qmd:<command>` passthrough.

## Process model

- **One TS binary, distributed via npm as `dither`.** Node-first, Bun-compatible. Optional `bun build --compile` for single-file distribution.
- **Self-respawning daemon.** First `dither <anything>` checks the PID at `~/.dither/dither.pid`; if dead, spawns the daemon as a detached child (PM2-style).
- **launchd plist / systemd user unit** registered as a best-effort secondary on first run. If it breaks (Node version manager drift), self-respawn carries the system.
- **CLI ↔ daemon over a unix socket** at `~/.dither/dither.sock`. Newline-delimited JSON, no framework.
- **Daemon owns:** scheduler, file watchers, plugin processes, qmd handle, MCP server, key store, run-dir promoter.

## Three principals

| principal  | reaches data via                          | enforcement                                                                                                            | default scope          |
| ---------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **user**   | CLI → unix socket                         | none — you own the box                                                                                                 | all collections        |
| **plugin** | writes files in run dir → daemon promotes | **Deno flags** (cannot write outside run dir + own state) + **daemon ACL** (only granted collections accept its files) | only what it's granted |
| **agent**  | MCP or CLI with API key                   | **daemon ACL** (key scopes filter every read/write)                                                                    | what the key permits   |

API keys are simultaneously a **grant** (required for remote/synced access) and a **restriction** (scope what they can do). Local CLI usage on the host machine doesn't need a key — Unix permissions on the socket are sufficient.

## Storage / data model

**The entry is a markdown file. Collections are just folders.** qmd indexes the directory tree directly; dither never invents a database for entries.

dither separates two roots on disk:

- **dither home** (`~/.dither/` by default; `$DITHER_HOME` overrides) holds dither's bookkeeping: config, plugins, grants, runs, locks, logs, daemon state, qmd index.
- **library** is the markdown content. Configurable per-install at `dither init` time; defaults to `<dither-home>/library/`. `dither init --library <path>` adopts an arbitrary directory, canonicalised via `realpath`.

```
<dither-home>/                        ← bookkeeping
├── config.json                       ← {schema.version, library.path}
├── qmd-index.sqlite                  ← derived; always lives in dither home
├── env.json                          ← global env store
├── plugins/<plugin-name>/            ← author-owned, immutable post-install
│   ├── package.json
│   ├── plugin.ts
│   ├── deno.json
│   └── state/state.json              ← persistent, plugin-writable
├── grants/<plugin-name>.json         ← dither-owned: user-chosen ACLs + input values
├── runs/<run-id>/                    ← per-run scratch (auto-cleaned)
├── locks/                            ← per-plugin lockfiles
├── logs/                             ← daemon and detached-run logs
├── status.json                       ← daemon status snapshot
├── dither.pid                        ← daemon pid
├── keys/dither.sqlite                ← API key store (parked)
└── dither.sock                       ← daemon IPC (parked)

<library>/                            ← qmd-indexed, canonical (configurable location)
├── twitter/                          ← collection (a folder)
│   └── 2026/04/<id>.md
├── gmail/
│   └── 2026/04/25/<thread-id>.md
├── notes/
├── inbox/
└── attachments/                      ← raw blobs, content-addressed by UUID (parked)
    └── 7f3a8c10-…/screenshot.png
```

`dither init` is the required first step. Library-needing commands refuse until config exists. See [`specs/qmd-library.md`](./specs/qmd-library.md) for the design and `notes/qmd-index-reuse.md` for the parked "share an index file with qmd-CLI" feature.

### Collections

A collection is a top-level folder under the library. That's it. Plugin grants pin to collection paths (glob patterns over names); a future revision adds stable UUIDs for rename-safety.

Subfolders inside a collection are unrestricted. Plugins use whatever path scheme they want (`2026/04/25/…`, `important/…`); the grant covers the collection root and everything beneath.

### Frontmatter spec

```yaml
---
id: <uuid> # stable; survives renames/moves
source: gmail-ingest # plugin that created it
external_id: <provider-side id> # tweet id, gmail thread id, gh pr#
external_url: https://… # optional, for round-tripping
created: 2026-04-25T11:14:00Z
ingested: 2026-04-25T18:22:11Z
augmented_by: [summarize, link-related]
tags: [pr, dither, review]
attachments:
  - id: 7f3a8c10-… # uuid → attachments/<id>/<file>
    type: image/png
    name: screenshot.png
    ocr_text: "…" # optional, filled by an enricher
---
```

`id`, `source`, `created`, `ingested` are reserved and managed by the daemon. Everything else is plugin-controlled and may evolve. Hand-edits by the user are preserved.

### Attachments

UUID-keyed under `~/.dither/attachments/<uuid>/<original-filename>`. Multiple per entry. OCR / transcription is just an enricher plugin (or a first-party shipped one), filling `ocr_text` / `transcript` fields in the attachment object. v2 territory; the frontmatter shape is locked now so we don't churn later.

### Per-document styling (deferred)

Frontmatter-based hints (e.g. `kind: tweet`) can drive UI rendering later without changing the storage contract. v1 is markdown-uniform.

## Manifest — `package.json` with a `dither` block

A plugin is a normal Node-style directory. Its manifest lives inside a regular `package.json` (so plugins can also be regular npm packages, share linting, etc.) under a nested `dither` key. We never collide with npm's own fields.

The manifest **declares** what the plugin would like access to. The user **grants** the actual access at install time via CLI flags. The manifest is the install-time _default_ — used when no `--allow-*` flag is passed for a given grant kind. It is **not** an enforcement boundary: the grants file is the source of truth at promote time, and CLI flags can grant collections or net hosts the manifest didn't declare. (Required `env` and `files[]` are the exception — those still must be supplied or install fails.)

```jsonc
{
  "name": "dither-gmail-ingest",
  "version": "0.3.1",
  "author": "tobi",
  "homepage": "https://github.com/tobi/dither-gmail-ingest",

  "dither": {
    // store metadata
    "display_name": "Gmail Ingest",
    "tagline": "Sync your Gmail threads as markdown",
    "icon": "lucide:mail",

    // behavior — presence of options determines triggers
    "schedule": "every 15m",
    "watch": { "collections": ["inbox"], "glob": "**/*.md" },

    // env values the plugin reads at run time. All strings — coerce in code
    // if you want a number/bool. The user supplies values via `--env` or
    // grants access to a global value (managed by `dither env`) via
    // `--allow-env`.
    "env": [
      {
        "name": "GMAIL_OAUTH_TOKEN",
        "description": "OAuth refresh token from Google",
      },
      {
        "name": "MAILBOX",
        "description": "Mailbox to sync",
        "default": "INBOX",
      },
    ],

    // file/folder paths the plugin reads. Granted via `--file ID=PATH`. The
    // host validates kind + existence at install and adds the path to Deno's
    // --allow-read.
    "files": [
      {
        "id": "ARCHIVE",
        "name": "Twitter archive zip",
        "kind": "file",
        "extensions": [".zip"],
        "required": false,
      },
    ],

    // network grant — install-time default. The user can override or widen
    // via `--allow-net`. Default-grants the full list when no flag is passed.
    "net": ["gmail.googleapis.com"],

    // collection grant — glob patterns over nestable path identifiers.
    // Promote rejects entries whose `collection:` frontmatter doesn't match
    // any glob in the resolved grant set. Manifest is the install-time
    // default; `--allow-collection` overrides. Examples: "gmail", "messages/**",
    // "messages/*", "messages/2026-*".
    "collections": ["gmail"],
  },
}
```

### No type enum — behavior emerges from options

Plugins are not categorized as `interval` / `trigger` / `enhance`. Behavior emerges from what's in the manifest:

- `schedule` set → runs on a timer
- `watch` set → runs when matching files change
- both → both
- neither → only manual / agent-triggered

Every plugin is also manually triggerable via `dither plugin run <name>` or MCP regardless of these options. The plugin code can introspect `DITHER_TRIGGER` (`scheduled` | `watch` | `manual`) to differentiate if it cares.

### `env` vs `files`

- **`env`**: name → string values. Replaces the old `inputs[]` and `host_env`. No `kind`, no `secret` flag — privacy is the user's call. Granted via `--env NAME=VALUE` (literal) or `--allow-env NAME` (read from the global env at `~/.dither/env.json`). Plugin reads them via `input.env[name]`. All values are strings; coerce in plugin code.
- **`files`**: file/folder paths. Granted via `--file ID=PATH`. The path is added to Deno's `--allow-read` allowlist; the SDK's `readFile(id)` is the canonical accessor.

`watch` and `schedule` are user-configurable: the manifest's values are _defaults_ the user can accept, edit, or override at install time (or later via `dither plugin grant <name>` — that subcommand is parked for the interactive-prompt phase).

### Permission derivation (daemon → Deno)

```
grants.net      → --allow-net=host1,host2
grants.files    → --allow-read=<resolved file/folder path>, …
                + --allow-read=<plugin dir>, <run dir>, <SDK path>
                + --allow-write=<plugin state dir>, <run dir>
                + --allow-env=DITHER_RUN_DIR,DITHER_INPUT_FILE,
                              DITHER_STATE_FILE,DITHER_TRIGGER,
                              DITHER_PLUGIN_NAME
                (env values ride in input.json — never as host env vars)
```

`grants/<name>.json` is dither-owned: it has timestamps, is the single source of truth for what the host enforces, and survives plugin updates.

## Plugin run lifecycle

```
1. Daemon decides to run (schedule fires, file watcher triggers, or manual via CLI/MCP)

2. Daemon prepares:
   - mkdir -p runs/<run-id>/
   - writes runs/<run-id>/input.json with:
       { trigger: "scheduled" | "watch" | "manual",
         env: {…},           ← merged: grant literals + global lookups + manifest defaults
         files: {…},         ← resolved absolute paths for granted `files`
         targets: [paths…]   ← for watch-triggered runs only
       }

3. Daemon spawns:
   deno run \
     --allow-read=plugins/<name>/state,runs/<run-id>,<file inputs>… \
     --allow-write=plugins/<name>/state,runs/<run-id> \
     --allow-net=<from manifest+grants> \
     plugins/<name>/plugin.ts

   Env: DITHER_RUN_DIR, DITHER_INPUT_FILE, DITHER_STATE_FILE, DITHER_TRIGGER

4. Plugin reads input.json, optionally reads state.json, does work.
   Writes new/updated entries as *.md into DITHER_RUN_DIR.
   Writes attachments as raw files alongside (referenced from frontmatter by relative name).
   Overwrites state.json with new cursor.

5. Plugin exits.

6. Daemon promotes runs/<run-id>/:
   - validates each *.md has source = <this plugin>
   - validates each *.md targets a collection the plugin is granted
   - assigns/preserves entry id; assigns attachment UUIDs; copies attachments to <library>/attachments/
   - moves *.md to <library>/<collection>/<plugin-chosen-subpath>/<id>.md
   - re-indexes via qmd
   - persists plugin's state.json
   - rm -rf runs/<run-id>/

7. Daemon records run outcome in dither.sqlite (success/failure, duration, files written).
```

Run dir is **flat scratch**. No `in/`/`out/` subdirs. Persistent `state.json` lives at `plugins/<name>/state/` and is granted directly via Deno flags — no shuttle copies. Everything the plugin needs (env values, file paths, trigger info, watch targets) arrives in one `input.json`.

## Trigger orchestration

Kept deliberately simple. The daemon does the minimum and lets plugins handle their own logic.

- **Schedule**: single string in manifest/grants. Raw cron handled by **`croner`** (zero-deps, TS-first, pure JS — mac/linux/windows). Human shorthand (`every 15m`, `daily at 9am`, `weekdays at HH:MM`) handled by a small in-house parser (~40 lines) that emits cron and falls through to croner. Unparseable strings fail loudly at install. All scheduled plugins tick from a single in-process scheduler.
- **Watch**: `chokidar` against the configured collections + glob. Default glob `**/*.md`. New files trigger runs; edits also trigger (chokidar emits `change` for modified content). No content-hash bookkeeping in v1 — if mtime changes, watch fires.
- **Self-trigger suppression**: when the daemon promotes a file, it records the path and mtime in an in-memory recently-promoted map (TTL ~2s). Watcher events matching are dropped. Prevents an enricher from looping on its own writes — the simplest possible mechanism.
- **Loop detection (not prevention)**: the daemon tracks plugin-trigger chains (plugin A's write triggered plugin B, B's write triggered C, …). If a chain reaches a configurable depth (default 3), the daemon stops the chain, surfaces an error in `dither status` and the next CLI invocation, and logs the cycle. We don't try to prevent loops — we detect them and refuse to keep going. Threshold is configurable.
- **Watch debounce**: when many file events fire in close succession (e.g. an importer drops 200 files), the daemon coalesces events to a single plugin run with all paths in `input.json.targets`. Default 5s window, 30s cap. Configurable per plugin via `watch.debounce`.

Dedupe / upsert by `external_id` is **not in v1**. Plugins create files; if they re-run, they create new files. Plugin authors handle their own deduplication for now. v2: optional, configurable per collection, with an `(source, external_id) → entry_id` index in `dither.sqlite`. The frontmatter shape (`external_id` field) is locked now so v2 is non-disruptive.

No conflict policy. If two plugins write to the same file, last-write-wins. The user can read the markdown and judge what happened. Liberal model — plugins are free to use whatever conventions they want (HTML comment fences, frontmatter sub-objects, …) without the host imposing structure.

## Browser plugin runtime (parked, will redefine its own grant surface)

When the browser sidebar lands, it will introduce its own grant kind (likely `browser` at the top level, granted via something like `--allow-browser <host>`) — parallel to `net`/`env`/`files`/`collections`. The shape below is the still-good design from before the grants redesign; it just needs the surface re-attached to the new grant model when implemented.

Plugins that declare a `browser` grant get a Playwright/Chromium sidecar. Three processes during a run instead of two:

```
daemon ─→ Deno plugin ─(websocket)─→ Playwright/Chromium
                                     persistent profile,
                                     network-filtered at the browser
```

- **Network filter at the browser layer.** The `hosts` list is the _navigation_ whitelist — the URL bar. Subresources (Google Fonts, CDNs, analytics, anything a normal browser auto-loads from the page) are not filtered. Trying to micro-allowlist subresources defeats the point of using a real browser. Plugin authors who want stricter network control can use the top-level `net` grant instead and skip the browser entirely.
- **Persistent per-plugin profile.** `~/.dither/plugins/<name>/browser-profile/` is the Chromium `userDataDir`. Cookies, localStorage, IndexedDB persist across runs. The Deno plugin does not directly access this dir; the Chromium process owns it. Plugin code talks to Playwright via the websocket only.
- **Headed ↔ headless is a runtime choice.** Plugin opens a session with `{ headed: true }` for first-time login (user solves captcha, signs in) and switches to `{ headed: false }` for unattended refresh runs. Cookies set in headed sessions work in headless ones because the profile is shared.
- **Implicit consent.** If a browser grant is given at install, headed windows are allowed. No separate per-session prompt. The user accepted "this plugin can drive a browser" once.
- **Trust model.** Inside a navigated host, anything a normal browser can do is allowed — that's the contract of granting browser access. We don't try to sandbox JS execution within pages. If the user grants browser access to `twitter.com`, they're trusting the plugin not to do something stupid on twitter.com.

LLM-assisted automation (e.g. `page.aiClick("login button")`) is **v2**. Manifest keeps `browser.llm_assist` reserved but unimplemented in v1. Plugins use selectors.

## Install flow (sketch — to refine)

`dither plugin install <git-url|local-path>`:

1. Clone/download. Detect one or more directories with a `package.json` containing a `dither` block. If multiple, prompt to pick (or the URL was `<repo>/<subdir>`, take that).
2. Show the user a single confirm screen with the manifest's defaults rolled up:

   ```
   gmail-ingest v0.3.1 — Sync your Gmail threads as markdown

     Talks to:        gmail.googleapis.com
     Reads secret:    GMAIL_OAUTH_TOKEN
     Reads input:     Mailbox to sync = "INBOX"
     Writes to:       collection "gmail"  (will be created)
     Schedule:        every 15 minutes

     [c]onfirm   [e]dit   [a]dvanced   [n]o
   ```

   - **confirm** — accept everything, prompt for any required inputs/secrets, install.
   - **edit** — interactive walk through every _configured_ item, allowing override.
   - **advanced** — walk through _every option_, including ones the plugin author left blank (e.g. add a `schedule` to a manual-only plugin).
   - **no** — abort.

3. Required secrets/inputs without defaults are always prompted (regardless of confirm).
4. Final grants land in `grants/<name>.json`; `package.json` is never modified.

The marketplace website generates the same `dither plugin install <url>` command for the user to paste; in-CLI prompts collect the rest. Power users can construct flagged versions to skip prompts.

## CLI surface (sketch — to be refined)

```
# core
dither search <phrase> [-c <collection,…>] [--vec | --fts | --hybrid] [--rerank]
dither get <id|path> [--lines <start>:<end>] [--full]
dither list [collections|entries|plugins|keys] [-c <collection>]
dither add <path|->                                                     # write entry to default collection
dither status                                                           # daemon health, recent runs

# daemon
dither daemon start|stop|status|logs

# plugins
dither plugin install <git-url|local-path>
dither plugin list
dither plugin run <name> [-- <args>]
dither plugin grant <name>                                              # interactively review/edit grants
dither plugin remove <name>
dither plugin logs <name>

# collections
dither collection list
dither collection create <name>
dither collection rename <old> <new>
dither collection delete <name>

# keys (for agents)
dither key create --name <label> [--collections <names>] [--read-only] [--expires <when>]
dither key list
dither key info <name>                                                  # prints skill.md
dither key revoke <name>

# qmd raw access (passthrough, advanced)
dither qmd:<command> …                                                  # e.g. dither qmd:embed -f

# sync (paid, v2)
dither sync status
dither sync enable / disable

# store
dither store browse                                                     # opens marketplace TUI/UI
dither store install <plugin-id>                                        # equivalent to plugin install <url>

# meta
--dry-run                                                           # available on every mutating command
```

`dither start` / `dither stop` are _not_ top-level — they resolve to `dither daemon start|stop`.

## Search behavior

- **Default**: all collections; hybrid (BM25 lex + vector) — qmd's `query` mode minus reranking by default for speed; opt into reranking with `--rerank`.
- **Filterable**: `-c <collection,…>` restricts.
- **Pre-scoped by API key**: a key with `collections: [gmail]` filters silently; `-c notes` from such a key returns empty (no error, to avoid leaking the existence of out-of-scope collections).
- **Document lookup**: agents get search results with snippet ranges (`{ docid, path, snippets: [{ start_line, end_line, text }] }`) and can fetch a section with `dither get <id> --lines 50:120`. Token-efficient by default; full-document fetch is opt-in.

The CLI exposes a _small_ subset of qmd's surface (search, get, multi-get, status). Anything more advanced is `dither qmd:<command>`.

## MCP — local free, hosted paid

**Tools (v1):**

| tool                                             | always-on? | what it does                                                                        |
| ------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------- |
| `search(query, collections?, mode?)`             | yes        | hybrid search; returns `{id, path, score, snippets:[{start_line, end_line, text}]}` |
| `get(id_or_path, lines?)`                        | yes        | fetch entry or section by line range                                                |
| `list_collections()`                             | yes        | list collections visible to the key                                                 |
| `entry.create({collection, body, frontmatter?})` | opt-in     | agent saves something (e.g. conversation note)                                      |
| `plugin.run(name, args?)`                        | opt-in     | agent triggers a plugin                                                             |

`update` / `delete` for agents are not in v1 — high blast radius, low value, easy to add later.

**Transports:**

- **stdio**: `dither mcp [--key <token>]`. Claude Desktop and similar spawn it as a subprocess. No key = full local-user access (the process boundary is the authentication). With key = scoped to that key.
- **HTTP/SSE**: `dither mcp --http --port 8181 [--key required]`. Always key-required. For agents that don't manage subprocesses, or for hosted sync (v2+).

Same MCP protocol, two transports.

**Hosted MCP (v2+):** server-side qmd index reproduced from synced files; API keys required. Same tool surface.

## API keys

```
dither key create --name "claude-research" \
  --collections gmail,github,notes \    # absent = all (within capability)
  --read-only \                          # default; --read-write opts in to writes
  --expires 30d                          # optional
```

Stored in `~/.dither/keys/dither.sqlite`. Token shown **once at creation** (hash stored, value never retrievable again).

A key's capabilities cap what tools it can call; collections cap what it sees within those tools. Both layers enforced **silently** — out-of-scope queries return empty, not an error. This avoids leaking the existence of hidden collections via error messages.

### `skill.md` (human-authored in v1)

For v1, we ship a hand-crafted `skill.md` template on the documentation site. The user copies it, fills in their key, pastes into their agent's config (e.g. Claude Desktop's `claude_desktop_config.json`).

A future `dither key info <name>` command will auto-emit a personalized `skill.md` when the web version arrives — that's a v2 piece, not a v1 blocker.

## Marketplace, edge service, and updates

Two pieces:

**Plugin code lives on git** (GitHub or any git URL). The edge service doesn't host plugin code; it points at it.

**Edge service** extends the existing `mmry-edge` repo (Next.js on Vercel, GitHub-API proxy) with **Postgres** for install events and reviews. Vercel Postgres / Neon is the path of least resistance; Supabase or any managed Postgres works the same. No ORM heroics — Drizzle or `pg` directly.

- Lists available plugins; serves manifest excerpts for the marketplace UI.
- Wraps the GitHub fetch during install/update: client → edge → GitHub. Lets us use server-side GitHub tokens (rate-limit shielding for users) and add caching.
- Records install/update events: `{ plugin, version, timestamp }`. No user identity, just counts. This is the only "phone home."
- Hosts the review system: 5-star rating + text review per plugin.
- Generates the copy-paste `dither plugin install <ref>` snippet for the marketplace UI.

`mmry-edge` already has the GitHub-proxy + Vercel skeleton; we extend it with a small store (Postgres or similar) for install counts and reviews. No tracking or DB exists in `mmry-edge` today — that's the new piece.

**Install / update mechanics:**

- `dither plugin install <git-url>` resolves through the edge by default; `--no-edge` opts out (direct git clone, no install record).
- Install pins the **commit SHA** in `grants/<name>.json` — the version is locked.
- `dither plugin update <name>` is **always explicit** in v1. Pulls the new manifest, **diffs the `dither` block** against the recorded grants:
  - Permissions widened (new hosts, new collections, new browser access) → prompts with the diff highlighted, just like a fresh install.
  - Permissions unchanged → updates silently.
  - This is the load-bearing protection: a plugin source can't change what it does to your machine without an explicit re-grant.
- Auto-update toggles, both default off:
  - per-plugin: `dither plugin config <name> --auto-update`
  - global: `dither config set updates.auto false`

**No signing in v1.** Sandboxing (Deno flags + daemon ACL during promote) is the trust boundary; a verified-author signature isn't worth the author-onboarding cost yet. v1.5+ may add optional Sigstore / GPG signing as additive trust signal — unsigned plugins still install.

**No remote kill switch.** Local-first means the user's machine doesn't phone home for permission to keep running. If a plugin is later found malicious, users find out from external channels.

## Parked for next session

These were touched but explicitly deferred. Frontmatter and manifest fields they would interact with are reserved now so v2 doesn't churn v1 plugins.

- **Sync v2** — paid file sync; server reproduces qmd index from synced files; hosted MCP. Pricing model: thin margin on object storage + compute. Conflict resolution if two laptops both run schedules against synced files (lease/leader file vs. per-machine schedules).
- **WASM SQLite for web/edge surfaces** — `@sqlite.org/sqlite-wasm` for a browser-based "browse your index" demo when sync v2 lands; potentially WASM SQLite at the edge if the edge service ever does search proxying instead of just CRUD.
- **Native UI sketch** — likely menu-bar app talking to the daemon over the existing unix socket; daemon health, pending grants, recent runs. Grows from CLI status reports, doesn't replace the CLI.
- **Embedding cost** — qmd embeds eagerly. For large corpora (500k+ entries) this gets expensive. Possible answers: lazy / on-query embedding, chunked re-indexing, configurable embedding model.
- **Browser ai-assist** — `aiClick("login button")` etc. via Ollama or cloud key; install-time prompt if a plugin requires it and no model is configured.
- **Dedupe / upsert by `external_id`** — per-collection toggle, `(source, external_id) → entry_id` index in `dither.sqlite`. v1 plugins create new files on re-run.
- **`dither key info` auto-emit** — personalized `skill.md` generation; lands with the web version.
- **Optional plugin signing** — Sigstore / GPG; additive trust signal, never gating.
- **Per-run tmp dir** — each plugin run gets its own scratch tmp dir (separate from the run dir, which is reserved for entry outputs). Some plugins need a place to drop intermediate working files (zip extracts, downloaded payloads, intermediate transforms) without leaving them on disk between runs. Spec deferred; just noting the need.

## Tooling & dependencies

VoidZero-aligned where it makes sense; boring elsewhere.

| concern         | choice                                                     |
| --------------- | ---------------------------------------------------------- |
| runtime         | Node ≥ 22 (Bun-compat as a non-blocking goal)              |
| build           | `tsdown` (Rolldown-powered TS bundler)                     |
| test            | `vitest`                                                   |
| lint            | `oxlint` (add ESLint later only if a rule gap surfaces)    |
| format          | `oxfmt` (Oxc formatter)                                    |
| typecheck       | `tsc --noEmit`                                             |
| dev pkg manager | `npm` (workspaces for cli + sdk)                           |
| CLI framework   | `citty`                                                    |
| logger          | none — plain `console.*` for v1                            |
| sqlite          | `node:sqlite` (built-in on Node 22+; `bun:sqlite` for Bun) |
| validation      | `zod` (manifest, grants, input.json)                       |
| frontmatter     | `gray-matter`                                              |
| cron            | `croner` + small in-house shorthand parser                 |
| file watch      | `chokidar`                                                 |
| process spawn   | `node:child_process`                                       |
| browser         | `playwright` (sidecar)                                     |
| license         | MIT                                                        |

**Repos (v1):**

Public stuff lives together in a monorepo (npm workspaces). Private stuff stays in its own repos.

**`dither`** (public, MIT) — npm workspace:

```
dither/
├── docs/                     → fumadocs site (Next.js)
└── packages/
    ├── cli/                  → publishes `dither` on npm; bin `dither`
    ├── plugin/               → publishes `@dither/plugin` (SDK)
    └── plugins/
        ├── gmail-ingest/
        ├── summarize/
        └── …                 → first-party plugins, one folder each
```

**Private repos** (separate, never in the monorepo):

| repo          | what it is                                                 |
| ------------- | ---------------------------------------------------------- |
| `dither-edge` | Next.js + Postgres edge service (renamed from `mmry-edge`) |
| `dither-sync` | paid sync server (v2)                                      |

Public boundary = trust boundary. Sandbox and SDK code must be auditable, hence MIT in the monorepo. The edge service is private because it carries business logic (install tracking, reviews, future billing) and operational secrets.

## Open questions (small, near-term)

- None blocking. Naming sanity: `dither` package + `dither` CLI binary; verify `npm view dither` availability at phase 0.

## Decision log

- **2026-04-25** — Process model: single npm-distributed TS binary; Node-first, Bun-compatible; self-respawning daemon with launchd/systemd as best-effort secondary; CLI ↔ daemon via unix socket.
- **2026-04-25** — Plugin contract: file-based, no IPC. Daemon spawns Deno with derived flags; plugin reads `input.json`, writes markdown + attachments to a flat run dir, overwrites its persistent `state.json`. Daemon promotes outputs into `entries/`, enforcing collection grants.
- **2026-04-25** — Storage: qmd-as-storage. Markdown files under `entries/<collection>/...`, frontmatter with `id, source, external_id, external_url, attachments[]`. Attachments are content-addressed by UUID under `attachments/`.
- **2026-04-25** — No ownership concept. Collections are folders. Security model is access (read/write grants), not ownership.
- **2026-04-25** — Collections have stable UUIDs and human names; plugin grants can scope by either.
- **2026-04-25** — Three principals (user / plugin / agent). API keys are both grant (for remote) and restriction (for scope); local CLI doesn't need a key.
- **2026-04-25** — Search: default to qmd hybrid (lex + vec) without reranking; `--rerank` opts in. Document lookup returns snippet ranges; full-text is opt-in. Raw qmd via `dither qmd:<command>`.
- **2026-04-25** — `dither start` / `dither stop` reserved for daemon control under `dither daemon start|stop`.
- **2026-04-25** — Manifest lives in `package.json` under nested `dither` key. No collision with npm fields. Plugins can be regular npm packages.
- **2026-04-25** — No plugin type enum. Behavior emerges from manifest options (`schedule` ⇒ timed; `watch` ⇒ file-triggered; both ⇒ both; neither ⇒ manual-only). All plugins are manually triggerable regardless.
- **2026-04-25** — `inputs` (text: string/secret/number/bool) and `files` (file/folder picker) are separate top-level fields. Secrets go to OS keychain; values delivered via `input.json.secrets`, never env.
- **2026-04-25** — Permissions split into `host_net` / `host_env` to make clear they're host-level (not user-data) permissions. `run` and `ffi` not in v1.
- **2026-04-25** — Plugin's `package.json` is immutable post-install. User-chosen grants live in dither-owned `grants/<name>.json`. Survives plugin updates cleanly.
- **2026-04-25** — Install flow: `confirm | edit | advanced | no`. `edit` is interactive (TUI), not `$EDITOR`. `advanced` reveals options the plugin author left blank (e.g. add schedule). Plugin install supports multi-plugin git repos via subdirectory detection.
- **2026-04-25** — Schedule: single string in the manifest, parser accepts both human ("every 15m") and raw cron. No dual representation. Single in-process scheduler.
- **2026-04-25** — Watch: chokidar on collections + glob (default `**/*.md`); new files and edits both trigger (mtime-based, no content hash in v1). Debounce coalesces bursts into one run with all paths in `input.json.targets`.
- **2026-04-25** — Self-trigger suppression: in-memory recently-promoted map with ~2s TTL; watcher drops matching events. Simplest mechanism that breaks the obvious loop.
- **2026-04-25** — Loop detection, not prevention: if a trigger chain reaches configurable depth (default 3), daemon stops and surfaces an error. No pipeline orchestration — just detection.
- **2026-04-25** — No conflict policy. Two plugins writing to the same file ⇒ last-write-wins. Plugins are free to invent their own conventions; host doesn't impose body fences or frontmatter key allowlists.
- **2026-04-25** — No dedupe in v1. `external_id` field is reserved in frontmatter for v2 (per-collection toggle, `dither.sqlite` index).
- **2026-04-25** — MCP: read trio (`search`, `get`, `list_collections`) always on; write pair (`entry.create`, `plugin.run`) opt-in via `--read-write` keys. No `update`/`delete` in v1.
- **2026-04-25** — Transports: stdio (default, local subprocess; no key = full local access; with key = scoped) + HTTP/SSE (always key-required).
- **2026-04-25** — Keys stored in `~/.dither/keys/dither.sqlite`. Token shown once. Out-of-scope queries return empty, never error.
- **2026-04-25** — `skill.md` is hand-crafted on the docs site for v1. Auto-emit via `dither key info` deferred to v2 with the web version.
- **2026-04-25** — Browser plugin runtime is in v1 via Playwright sidecar. Per-plugin persistent profile dir. `permissions.browser.hosts` is a top-level navigation whitelist; subresources unrestricted (let browsers be browsers). Headed ↔ headless is runtime-controlled by the plugin (single install-time consent for browser access). LLM-assist deferred to v2.
- **2026-04-25** — Plugin install/update goes through an edge service (extension of `mmry-edge`) that proxies GitHub, records install events, and hosts reviews. `--no-edge` opts out. No user identity recorded — install/version counts only.
- **2026-04-25** — Install pins commit SHA in grants. Updates always explicit in v1. Update flow diffs the `dither` block; widened permissions re-prompt with the diff highlighted; unchanged permissions update silently.
- **2026-04-25** — Auto-update toggles default off in v1: per-plugin (`dither plugin config <name> --auto-update`) and global (`dither config set updates.auto`).
- **2026-04-25** — No signing in v1. Sandboxing (Deno + daemon ACL) is the trust boundary. No remote kill switch — local-first means the machine doesn't phone home for permission. Optional Sigstore/GPG signing parked for v1.5+ as additive signal.
- **2026-04-26** — Cron: `croner` for parsing/scheduling raw cron; small in-house parser (~40 lines) for human shorthand → cron, falling through to croner. Pure JS, cross-platform.
- **2026-04-26** — Edge service stack: Next.js (extending `mmry-edge`) + Postgres (Vercel Postgres / Neon as default; any managed Postgres works). Drizzle or raw `pg`. No ORM heroics.
- **2026-04-27** — Tooling: tsdown (build), vitest (test), oxlint (lint), oxfmt (format), npm workspaces (dev pkg mgr), Node ≥ 22 runtime. CLI framework `citty`. No logger lib in v1 — plain `console.*`. SQLite via `node:sqlite`. Validation `zod`. Frontmatter `gray-matter`. License MIT. All-Oxc story for lint+format keeps tooling fast and unified.
- **2026-04-27** — Repo layout: separate repos, no monorepo. Public/MIT: `dither` (CLI + daemon), `dither-plugin` (SDK), `dither-plugins` (first-party plugins), `dither-docs` (later). Private: `dither-edge` (renamed from `mmry-edge`; Next.js + Postgres). Public boundary = trust boundary; private boundary = business + ops secrets.
- **2026-04-27** — WASM SQLite rejected for v1 (we're a Node daemon; `node:sqlite` already does what's needed). WASM parked for v2 web/edge surfaces (browser-based index demo, edge search proxying) where it actually pays off. Plugin runtime stays Deno; WASI swap rejected (loses ecosystem and security primitives we want).
- **2026-04-27** — Switched from pnpm to npm. Public stuff lives in one npm-workspace monorepo (`dither` with `packages/cli`, `packages/plugin`, `packages/plugins/*`, `docs/`). Private stuff (`dither-edge`, `dither-sync`) stays in separate repos.
- **2026-04-29** — Dropped the `apps/` directory. CLI moved to `packages/cli`. Reasoning: `apps/cli` was the only entry under `apps/`; the docs site went under `docs/` (next to `packages/`). Splitting one binary into a separate top-level dir didn't earn its keep — `packages/*` covers the published-to-npm artifacts uniformly.
- **2026-04-30** — **Grants redesign**. Plugin permission model rebuilt around one concept: grants. Manifest declares the maximum (what the plugin would like); user-supplied install/run flags grant the actual subset. `inputs[]` → `env[]` (all strings, no `kind`, no `secret` flag — privacy is the user's call). `permissions` block dropped: `host_net` → top-level `net`, `host_env` removed (env is the only env), `permissions.browser` parked for the browser sidebar's own grant surface. `collections.writes/reads/auto_create` → flat `collections: string[]`, validated against grants at promote (not against the manifest). New global env store at `~/.dither/env.json` managed by `dither env set/get/unset/list`. SDK `PluginInput` is now `{ trigger, env, files, targets }` — the `config`/`secrets` split is gone. `plugin run <name|path>` accepts a path and auto-installs (flags persist as grants); `plugin run <name>` with grant flags layers them as ephemeral per-run overrides without mutating the grants file. CLI grant flags (parallel on `install` and `run`): `--env NAME=VALUE`, `--allow-env NAME` (reference a global), `--file ID=PATH`, `--allow-net HOST`, `--allow-collection NAME`. Default-grant-from-manifest if no flag passed; manifest is the ceiling, flags narrow.
- **2026-05-06** — **Nestable collections + manifest-as-default.** Collections become path identifiers (`messages/tom`); grants become glob patterns over those paths (`messages/**`, `messages/*`, `messages/2026-*`). Standard glob semantics — no implicit subtree from a literal name. Promote validates the entry's frontmatter `collection` (no `..`, no leading/trailing `/`, allowed charset, no `.md` suffix), then matches against the grant glob set; first hit wins. New module `collection-paths.ts` (validateCollectionPath, grantsCover) backed by picomatch. qmd is untouched — top-level dirs under the library remain the only qmd collections; nesting falls out of qmd's existing `**/*.md` recursive glob. Same patch drops the **manifest-as-ceiling** rule for `net` and `collections`: the manifest declaration is now an install-time _default_ only — a `--allow-collection` or `--allow-net` flag at install can grant values absent from the manifest. The grants file is the source of truth at promote.
- **2026-05-07** — **dither home / library split + `dither init`.** Library path is now configurable via `<dither-home>/config.json` (two-level JSON, `library.path` is the only key in v1). `dither init` is the required first step; library-needing commands refuse with a clear error until config exists. Default library is `<dither-home>/library/`; `dither init --library <path>` adopts an external directory (validated, realpath-canonicalised). `dither init --force` reconfigures. `dither init --no-download` skips qmd model weight prefetch. The qmd index always lives in dither home (`<dither-home>/qmd-index.sqlite`) regardless of where the library is — **no index sharing with qmd-CLI** in v1. Plugin promote calls `updateIndex(touchedCollections)` for partial reindex; manual `dither index update` still does a full rescan. Index reuse / adopt-mode (sharing a dbPath with the user's existing qmd-CLI setup) is parked in `notes/qmd-index-reuse.md` with the full design + reasoning. Spec: `specs/qmd-library.md`. Plan: `plans/qmd-library.md`.
- **2026-04-27** — Formatter: `oxfmt` (not prettier). All-Oxc tooling for lint + format.
- **2026-04-27** — Renamed product: `openindex`/`oi` → `dither`. NPM package `dither`, scope `@dither`, CLI binary `dither`, env vars `DITHER_*`, runtime dir `~/.dither/`. Repos renamed throughout (`dither`, `dither-edge`, `dither-sync`, `dither-docs`).
