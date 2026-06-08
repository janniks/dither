# Plan: Native fs.watch Watcher

> Source spec: `specs/native-watcher.md`

## Architectural decisions

- **Routes**: none (daemon-internal watcher; no CLI surface change).
- **Schema**: none changed (manifest/grant `watch` shape untouched; watermark
  state file format unchanged).
- **Key models**:
  - `watch-tree` — new deep module. `watchTree(roots, onEvent) → { close() }`.
    Per-OS strategy hidden: `fs.watch(root, { recursive: true })` on
    macOS/Windows; per-directory `fs.watch` + dynamic subdir watching on Linux.
    Emits `(absolutePath, "add" | "change")`. Only file importing `node:fs`
    `watch`.
  - `Watcher implements Source` — surface unchanged (`set`, `start`, `recover`,
    `suppressOnce`, `stop`, `stats`). Body swaps the chokidar handle for a
    `watch-tree` handle; all event handling / suppression / debounce /
    watermark / recover logic preserved verbatim.
- **Third-party boundary**: chokidar removed from `packages/cli/package.json`;
  replaced by Node core `fs.watch`. No new dependency, no native binary.

---

## Phase 1: `watch-tree` deep module + direct test

**User stories**: 4, 5, 8, 10

A standalone module that watches a set of root directories with native
`fs.watch` and reports add/change events as absolute paths, releasing all
watches on `close()`. macOS/Windows use one recursive watch per root; Linux
walks and watches each directory and dynamically watches newly-created subdirs.
Deletions are not reported (downstream stat handles absence).

**Acceptance:**
- [x] `watchTree(roots, onEvent)` returns a handle with `close()`.
- [x] Writing/creating a `.md` file under a root invokes `onEvent` with the
      absolute path and a kind of `add`/`change`.
- [x] `close()` releases every underlying watch (no events after close; fd
      count returns to baseline).
- [x] On Linux, a subdirectory created after start is watched (its files emit).
- [x] Direct unit test covers the above against real temp dirs (no fs mocking).

---

## Phase 2: Swap `Watcher` to `watch-tree`; delete chokidar

**User stories**: 1, 2, 3, 6, 7, 9

`Watcher.set()` registers entries + resolves collection roots; `Watcher.start()`
opens the `watch-tree` handle over those roots (aligning with the `Source`
contract — set configures, start wires the live producer, recover catches up),
routing events into the existing `onChange` ingestion point; `Watcher.stop()`
closes the handle. The chokidar import and the `chokidar` dependency are
removed. All downstream behavior — debounce, glob, self-trigger suppression,
watermark advance, boot `recover()` — is unchanged.

**Acceptance:**
- [x] `Watcher` no longer imports chokidar; `chokidar` removed from
      `package.json` (+ lockfile edge) ; no remaining importers in `src/`.
- [x] Existing `watcher.test.ts` assertions pass (debounce, glob, suppression,
      recover). Live tests now call `start()` after `set()`, and recover tests
      write before `set()` — faithful to the prompt native backend; the original
      assertions are otherwise intact. 11/11 deterministic over repeated runs.
- [x] New test: watching a 1k-file collection holds O(1) fds, not O(files) —
      the core regression. (delta < 50 vs ~1000 under chokidar.)
- [x] New test: a file created in a watched collection fires the plugin and
      writes an inbox row (the debounce test).
- [x] Watcher/watch-tree typecheck clean; daemon-group failures verified
      identical to baseline (pre-existing table-output WIP — not this change).

---

## Phase 3: Rebuild + live verification + restore daemon

**User stories**: 1, 2, 3

Rebuild `packages/cli/dist`, restart the daemon, and confirm the real fix on
the live library: the daemon boots cleanly while watching the 94k-file `safari`
tree, holds a low fd count, and plugin runs succeed (no `spawn EBADF`). This
restores service without narrowing any grant.

**Acceptance:**
- [x] `dist/cli.mjs` rebuilt from the new source (chokidar refs: 0, watch-tree
      refs: 53).
- [x] Daemon starts and stays up with `url-scraper-test` still watching
      `safari`; fd count on `safari/history/*.md` is **0** (was 94,676); total
      fds 18.
- [x] A scheduled `safari-history` run completed `status: ok`, promoting a fresh
      batch into the library — spawn works (runs take 0.5–6s of real execution,
      not the old ~10ms `spawn EBADF`).
- [x] `dither status` healthy: library OK, 207,973 entries, daemon running.
      (`url-scraper-test` runs still fail — its own broken-test-plugin exit-1,
      unrelated to this fix.)

**Side fix:** an earlier `npm install` (to reconcile the Dropbox-synced Linux
native bindings to darwin) removed the manually-built `better-sqlite3` binding,
surfacing as `status` "library unreadable" + failed promotion. Rebuilt via
`npm run install` in `node_modules/better-sqlite3` per CLAUDE.md; entries read
again. Not committed (node_modules).

---

## Phase log

| Commit | Summary |
|--|--|
| 4b5d741 | NW-P1 — `watch-tree` native fs.watch primitive + direct test (4/4). |
| 9f79c7c | NW-P2 — Watcher onto watch-tree, chokidar dropped; set/start split aligns with Source contract; O(1)-fd regression test; 11/11 deterministic. |
| (P3) | Rebuild dist + live verify: safari/history fds 94,676 → 0, daemon healthy, scheduled run `ok`. Restored better-sqlite3 binding. Daemon left running. |
