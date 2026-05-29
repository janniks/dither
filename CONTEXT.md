# openindex (dither)

A local CLI that collects, indexes, and searches a personal markdown corpus. A long-lived daemon performs slow work (model download, indexing, embedding); plugins import markdown from external sources; the user runs `dither` to search and read.

## Language

### Library and content

**Library**:
The user-configured root directory that holds all collected markdown.
_Avoid_: corpus, vault, workspace, repo.

**Collection**:
A named subdirectory of the **Library** that groups markdown of a kind (notes, articles, transcripts).
_Avoid_: folder, namespace, bucket.

**Entry**:
A single markdown file inside a **Collection**.
_Avoid_: document, note, file, record.

**Grant**:
A glob-and-collection pair that authorises a **Plugin** to write into specific paths under the **Library**.
_Avoid_: permission, scope, allowlist.

### Plugins and runs

**Plugin**:
A user-installed module that imports external content into the **Library** as markdown.
_Avoid_: importer, source, integration, extension.

**Run**:
One execution of a **Plugin**, identified by a sortable `runId` and persisted under `~/.dither/history/`.
_Avoid_: invocation, job, task (job is reserved — see below).

**Promotion**:
The act of moving a staged file from a plugin's working area into a **Collection** under the **Library**.
_Avoid_: import, ingest, commit.

### Daemon and indexing

**Daemon**:
The single long-lived `dither` process that owns scheduled work, watchers, the qmd handle, and the daemon-side IPC.
_Avoid_: server, background process, worker pool.

**Job**:
A unit of slow work the daemon performs against qmd — currently `index`, `embed`, or `model-download`. Each acquires the corresponding named **Lock**.
_Avoid_: task, action, operation. Distinguish from **Run** (plugin-execution scope).

**qmd**:
The embedded `@tobilu/qmd` SDK that backs **Indexing** and **Embedding** with SQLite-backed FTS and vector search.
_Avoid_: store, db, engine.

**Indexing**:
Scanning the **Library** for new or changed **Entries** and writing their FTS rows into qmd.
_Avoid_: ingest, scan, sync.

**Embedding**:
Producing vector representations of indexed chunks via a local LLM and writing them into qmd.
_Avoid_: vectorising, encoding.

### Daemon ↔ CLI wire

The CLI and daemon communicate through six file-based primitives plus POSIX signals. Everything lives under `~/.dither/`.

**Lock**:
An `O_EXCL` mutex; body holds the holder PID. Plugins serialise per-plugin (`<plugin>.lock`); qmd-mutating work serialises via the named locks `qmd-download`, `qmd-index`, `qmd-embed`.
_Avoid_: mutex, semaphore, theme.

**Kick**:
A CLI-written JSON request meaning "run plugin X now." Daemon scans `kicks/` on SIGHUP and consumes after firing.
_Avoid_: ping, trigger, signal.

**Refire**:
A **Kick** with retry/schedule state — same family, distinct lifecycle. Stored per-plugin with `{fireAt, attempts, suspended}`. Daemon holds one timer per row.
_Avoid_: retry, reschedule, requeue.

**Inbox**:
NDJSON queue of watch events appended by the daemon's chokidar handler. Fire start atomically renames `inbox → inflight` (at-least-once delivery; restored on failure).
_Avoid_: queue, mailbox.

**Marker**:
A zero-byte presence flag. The lazy form of **Signal**: Signal = "wake up now" (POSIX, ephemeral); Marker = "next time you check, this state holds" (FS, persistent). They compose — write a marker + send a signal = "do this now AND remember it." Two flavours live today: `needs-reindex` (request-style, consumed when picked up) and `embed-disabled` (state-style, persists until explicit clear).
_Avoid_: flag, sentinel, breadcrumb.

**Run-log**:
The unified append-only JSONL stream of system events. Two on-disk scopes — global at `run-log.jsonl`, per-**Run** at `history/<runId>/events.jsonl` — but one module by intent. See ADR 0001.
_Avoid_: event log, history, audit log, journal (legacy name).

**Signal**:
POSIX (`SIGHUP`, `SIGTERM`, `SIGINT`). SIGHUP = reload config + grants + refires + run an index cycle. TERM/INT = graceful shutdown with a 30 s child-drain.
_Avoid_: notification, IPC.

Note that `status.json`, `env.json`, `config.json`, `dither.pid`, `history/<runId>/{manifest,result}.json`, and `jobs/<jobId>.json` are **not** IPC primitives — they are typed JSON state files at known paths.

## Relationships

- The **Library** contains one or more **Collections**; each **Collection** contains zero or more **Entries**.
- A **Plugin** declares **Grants** and produces **Entries** by **Promotion** during a **Run**.
- A **Run** writes events into the **Run-log** under a per-run scope; the **Daemon** writes events into the **Run-log** under the global scope.
- The daemon's index loop dispatches **Jobs** that each acquire a named **Lock** (`qmd-index`, `qmd-embed`, `qmd-download`).
- A `dither search` or `dither get` reads qmd directly; it never acquires a **Lock**.

## Example dialogue

> **User:** "I ran my Twitter **Plugin** and it imported three threads. Will they show up in search?"
> **Designer:** "The **Run** wrote three **Entries** via **Promotion**, then touched the `needs-reindex` **Marker**. The daemon's index loop picks it up next cycle and dispatches an **Indexing** **Job** under the `qmd-index` **Lock**. An **Embedding** **Job** follows under `qmd-embed`. After that, `dither search` against the new content returns them."

## Flagged ambiguities

- "journal" was used for per-**Run** history; "events log" was used for the daemon's global stream. Resolved: both are the **Run-log**, distinguished by scope.
- "job" and "task" were used interchangeably; "task" is reserved for the agent task system. Use **Job** for daemon work units, **Run** for plugin executions.
- "index" the noun (the qmd database) vs "index" the verb (the act of populating it) — prefer **qmd** for the noun, **Indexing** for the verb.
