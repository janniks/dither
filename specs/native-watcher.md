## Problem Statement

The daemon's file watcher leaks one OS file descriptor per watched file. A
plugin (`url-scraper-test`) watches the `safari` collection, whose
`safari/history` subtree holds ~94,676 flat `.md` files. chokidar 4 — which
dropped the bundled `fsevents` native module — watches **each file
individually** via `fs.watch`/kqueue on macOS, so the daemon accumulated
94,676 fds. Past a few-tens-of-thousands fd pressure, child-process `spawn`
fails with `EBADF` and **every plugin run dies in ~10ms**; a fresh daemon now
crashes at boot with `EMFILE` while re-arming the watch. The leak grows
monotonically as the scheduled plugin promotes new files.

## Solution

Replace chokidar with Node's **built-in `fs.watch`**, used correctly per-OS, so
watching a huge flat collection costs O(1)–O(dirs) fds instead of O(files). No
new dependency and no prebuilt native binary: the efficient macOS/Windows path
is reached through Node's own runtime (libuv wraps FSEvents /
ReadDirectoryChangesW for `recursive: true`); Linux uses per-directory inotify
watches (one fd per directory, not per file). chokidar is deleted.

The change is contained behind the existing `Watcher`/`Source` seam: only the
live-producer wiring inside `set()`/`stop()` changes. All downstream logic —
inbox append, self-trigger suppression, per-plugin debounce, the
(plugin,collection) mtime **watermark**, and the boot-time `recover()` walk —
is backend-agnostic and stays as-is. The watermark walk already covers any
events raw `fs.watch` drops.

## User Stories

1. As a dither user, I want the daemon to keep running no matter how large my
   collections grow, so that my plugins never silently stop firing.
2. As a dither user with a 94k-file `safari/history` collection, I want it
   watched with a handful of fds, so that the daemon doesn't exhaust the
   process fd table.
3. As a dither user, I want a fresh daemon to boot cleanly even with huge
   watched collections, so that a restart reliably restores service.
4. As a dither user on macOS, I want changes detected live via FSEvents, so
   that watch-triggered plugins fire promptly with low resource use.
5. As a dither user on Linux, I want changes detected live via inotify (real
   events, not polling), so that watching behaves the same as on macOS within
   one fd-per-directory.
6. As a dither user, I want a file changed while the daemon was down to still
   be picked up on next boot, so that the down-window doesn't lose work.
7. As a dither maintainer, I want chokidar removed entirely, so that the
   system has one fewer dependency and a smaller supply-chain surface.
8. As a dither maintainer, I want the OS-specific watching logic behind one
   small, testable interface, so that the rest of the watcher is unaware of
   the backend.
9. As a dither user, I don't want a plugin's own promoted files to re-trigger
   it, so that watch loops don't form (existing suppression preserved).
10. As a dither maintainer, I want no prebuilt C++ binary added, so that the
    install stays script-free under `ignore-scripts=true`.

## Implementation Decisions

### Backend primitive (decided)
- Use Node core `fs.watch`. No new npm dependency; no native addon.
- **macOS / Windows:** one `fs.watch(root, { recursive: true })` per watched
  collection root → FSEvents / ReadDirectoryChangesW, a single handle covering
  the whole subtree (proven: ~15 fds for the 94k-file tree). Recursive growth
  (new subdirs/files) is handled by the OS automatically.
- **Linux:** `recursive: true` is unsupported/buggy (crash-on-delete,
  missed-events). Instead walk the collection's directories once and
  `fs.watch(dir)` **non-recursively** per directory → inotify, one fd per
  directory. dither collections are flat, so a collection is typically one fd.

### Deep module extraction (decided — Q1)
- Extract a small backend module (working name `watch-tree`) exposing a minimal
  interface: given a set of root dirs + an `onEvent(path, kind)` callback,
  return a handle with `close()`. It hides the per-OS strategy. `Watcher.set()`
  calls it in place of `chokidar.watch(...)`; `Watcher.stop()` calls the
  handle's `close()`. The Watcher becomes backend-agnostic — it knows only
  "roots in, (path, kind) out."
- Inspiration (kept minimal): the pure-JS per-directory recursive pattern in
  `node-watch` (watch each dir, add a watch when a new subdir appears); the
  `subscribe(dir, cb) → { unsubscribe }` handle shape from `@parcel/watcher`.
  We keep only: a roots→handle factory and an add/change event callback. No
  glob support (the Watcher already globs), no event batching object, no
  ignore config — those live in the Watcher.

### Linux subdirectory growth (decided — Q2)
- Dynamic watching. macOS/Windows use `recursive: true`, so the OS watches new
  subdirs automatically — zero bookkeeping. On Linux, `watch-tree` walks the
  roots at start and watches each directory; when a directory-creation event
  arrives (a `rename` whose resolved path is a new directory), it walks and
  watches that new subtree. Removed directories drop their watch on close/error.
  For dither's flat collections this rarely fires, but it keeps nested growth
  correct without polling.

### Event semantics
- `fs.watch` yields `(eventType: "rename"|"change", filename)`. The module
  resolves `filename` to an absolute path and emits a single `(path, kind)`
  where kind is `add`/`change`; deletions (stat fails downstream) are ignored,
  matching today's behavior (the watcher only cares about add/change).
- No `awaitWriteFinish` equivalent: correctness depends only on mtime (read
  here) and file content (read later at plugin-run time), so mid-write stats
  are harmless. Raw duplicate events are absorbed by the inbox's path-dedup and
  the per-plugin debounce. No per-path event coalescing is added.
- Symlinked directories are not followed during the Linux dir-walk (avoids
  cycles); macOS/Windows recursive follows OS defaults.

### Reliability safety net (decided — Q3)
- Boot-only `recover()`, unchanged. The existing watermark walk runs at daemon
  boot/reconcile and backfills anything the live watcher missed; no periodic
  re-walk while running. A dropped live event surfaces at next boot or next
  scheduled run — acceptable because the watch is a promptness nudge, not the
  sole delivery path.

### Module sketch (deep modules)
- **`watch-tree`** — the new deep module. Interface:
  `watchTree(roots: string[], onEvent: (path, kind: "add"|"change") => void)
  → { close(): void }`. Encapsulates the entire per-OS strategy (recursive
  `fs.watch` on macOS/Windows; per-directory `fs.watch` + dynamic subdir
  watching on Linux) and absolute-path resolution behind one stable signature.
  This is the only file that imports `node:fs` `watch`. Tested in isolation.
- **`Watcher`** — unchanged surface (`implements Source`); its body loses the
  `chokidar` import and gains a `watch-tree` handle field set in `set()` and
  closed in `stop()`. All event handling, suppression, debounce, watermark, and
  recover logic stay verbatim.

### Unchanged (explicitly preserved)
- `Watcher` keeps `implements Source` and its method shapes: `set`, `start`
  (no-op), `recover`, `suppressOnce`, `stop`, `stats`.
- `onChange(gen, path, stats|undefined)` stays the single ingestion point; the
  new producer calls it exactly as chokidar's `add`/`change` handlers did. The
  `generation` staleness guard, suppression TTL map, debounce/`scheduleFlush`,
  watermark advance, and `walkMd` recover are untouched.
- `resolveWatchPath`, `watch-state.ts`, `inbox.ts`, daemon wiring
  (`watchEntriesOf`, reconcile on boot/SIGHUP) unchanged.
- chokidar removed from `package.json`.

## Testing Decisions

- Test external behavior through the `Watcher` public interface, as the
  existing `watcher.test.ts` does (drive real files under a temp library, assert
  fires + inbox rows). No mocking of `fs.watch`.
- Existing tests (debounce, glob filter, suppression, recover) must pass
  unchanged against the new backend — they are the regression net.
- New tests:
  - Watching a directory with many files holds O(1)/O(dirs) fds, not O(files)
    — the core regression. (Assert via process fd count before/after, with a
    modest file count so it's fast and cross-platform.)
  - A file created in a watched collection fires the plugin (add path).
  - A nested subdirectory created after `set()` is watched and its files fire
    (covers the Linux subdir-growth decision; on macOS this is automatic).
- The `watch-tree` module gets a thin direct test (decided — Q4): real temp
  dirs + files → assert `onEvent` fires with absolute path + `add`/`change`
  kind, and `close()` releases the watches. Pins the deep module's contract
  directly, independent of the Watcher.

## Out of Scope

- Re-adding `fsevents` or adopting `@parcel/watcher` / any prebuilt native
  binary (rejected by the no-binary constraint).
- Changing the manifest/grant `watch` schema or adding per-collection watch
  caps in code (the watcher fix makes a cap unnecessary).
- Narrowing `url-scraper-test`'s watch grant (a separate operational action to
  restore the live daemon; tracked outside this spec).
- Deletion/rename event handling beyond what's needed for add/change.
- Windows-specific validation beyond using `recursive: true` (macOS + Linux are
  the validated targets).

## Further Notes

- Root cause confirmed live: daemon pid 57746 (12d uptime) held 94,676 fds,
  exactly one per `safari/history/*.md`; restart crashed a fresh daemon with
  `EMFILE`. macOS `kern.maxfilesperproc = 245760`.
- chokidar 4 → 5 does not help: v5 is packaging-only (ESM-only, Node ≥20.19),
  same per-file watching, still no fsevents.
- The live daemon is intentionally left DOWN pending this fix (user decision);
  bringing it back requires either this fix or narrowing the watch grant.
