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
The single long-lived `dither` process that owns scheduled work, watchers, and the qmd handle.
_Avoid_: server, background process, worker pool.

**Reconciler**:
The daemon loop that compares observed qmd state to desired state (markers, lock files) and starts the **Jobs** needed to converge.
_Avoid_: scheduler, sync loop, controller.

**Job**:
A unit of slow work the daemon performs against qmd — currently `index`, `embed`, or `model-download`.
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

**Lock theme**:
One of `download`, `index`, `embed` — the three named exclusivity scopes that serialise qmd-mutating work.
_Avoid_: lock kind, lock type, lock category.

### Events and logs

**Run-log**:
The unified append-only JSONL stream that captures everything the system observed — daemon lifecycle, **Job** progress, **Run** events.
_Avoid_: event log, history, audit log, journal (legacy name).

**Marker**:
A zero-byte file (`needs-reindex`, `embed-disabled`) that signals desired state to the **Reconciler** across process boundaries.
_Avoid_: flag, sentinel, signal.

## Relationships

- The **Library** contains one or more **Collections**; each **Collection** contains zero or more **Entries**.
- A **Plugin** declares **Grants** and produces **Entries** by **Promotion** during a **Run**.
- A **Run** writes events into the **Run-log** under a per-run scope; the **Daemon** writes events into the **Run-log** under the global scope.
- The **Reconciler** dispatches **Jobs** that each acquire one **Lock theme**.
- A `dither search` or `dither get` reads qmd directly; it never touches a **Lock theme**.

## Example dialogue

> **User:** "I ran my Twitter **Plugin** and it imported three threads. Will they show up in search?"
> **Designer:** "The **Run** wrote three **Entries** via **Promotion**, then signalled the **Daemon**. The **Reconciler** is now running an **Indexing** **Job** under the `index` **Lock theme**. Once that finishes, an **Embedding** **Job** will follow under the `embed` **Lock theme**, and a `dither search` against the new content will return them."

## Flagged ambiguities

- "journal" was used for per-**Run** history; "events log" was used for the daemon's global stream. Resolved: both are the **Run-log**, distinguished by scope (`run` vs `global`).
- "job" and "task" were used interchangeably; "task" is reserved for the agent task system. Use **Job** for daemon work units, **Run** for plugin executions.
- "index" the noun (the qmd database) vs "index" the verb (the act of populating it) — prefer **qmd** for the noun, **Indexing** for the verb.
