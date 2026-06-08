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

`Watcher.set()` constructs a `watch-tree` handle over the resolved collection
roots and routes its events into the existing `onChange(gen, path, stats?)`
ingestion point; `Watcher.stop()` closes the handle. The chokidar import and
the `chokidar` dependency are removed. All downstream behavior — debounce,
glob, self-trigger suppression, watermark advance, boot `recover()` — is
unchanged and proven by the existing tests.

**Acceptance:**
- [ ] `Watcher` no longer imports chokidar; `chokidar` removed from
      `package.json`; no remaining importers in `src/`.
- [ ] Existing `watcher.test.ts` (debounce, glob filter, suppression, recover)
      passes unchanged.
- [ ] New test: watching a directory of many files holds O(1)/O(dirs) fds, not
      O(files) — the core regression.
- [ ] New test: a file created in a watched collection fires the plugin and
      writes an inbox row.
- [ ] Full `packages/cli` test suite is green.

---

## Phase 3: Rebuild + live verification + restore daemon

**User stories**: 1, 2, 3

Rebuild `packages/cli/dist`, restart the daemon, and confirm the real fix on
the live library: the daemon boots cleanly while watching the 94k-file `safari`
tree, holds a low fd count, and plugin runs succeed (no `spawn EBADF`). This
restores service without narrowing any grant.

**Acceptance:**
- [ ] `dist/cli.mjs` rebuilt from the new source.
- [ ] Daemon starts and stays up with `url-scraper-test` still watching
      `safari`; fd count on `safari/history/*.md` is ~0 (not ~94k).
- [ ] A plugin run (e.g. `safari-history`) completes without `spawn EBADF`.
- [ ] `dither status` / `plugin runs` show healthy (non-failing) runs.

---

## Phase log

|  |  |
|--|--|
|  |  |
