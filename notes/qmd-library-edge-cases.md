# qmd-library: edge cases & accepted v1 behavior

Sharp edges in the dither-home / library split that we identified during the
post-merge review and decided to live with for v1. Captured here so they're
findable later.

## 1. `init --force` while a plugin run is in flight

`runPlugin()` resolves the library root once at the start of a run (via
`paths.libraryRoot()`). If `dither init --force --library <new>` runs mid-flight:

- The running plugin's promote target is fixed to the *old* library (already
  resolved).
- `init --force` deletes `<dither-home>/qmd-index.sqlite` and re-registers
  collections against the new library.
- When the plugin finishes and calls `updateIndex(touchedCollections)`, that
  call re-opens the store and resolves the *new* library path. The promoted
  files are now orphaned in the old library.

**Net effect:** a small window where a single run can promote into the old
library while the index is built against the new one. The file isn't lost,
but it's unreachable via `dither search`.

**Why we accept it:** the per-plugin lock guarantees one run at a time but
doesn't (and shouldn't) cover the config-mutation surface. Locking config
during `init --force` would block the user from reconfiguring while any plugin
is running, which is worse UX.

**Mitigation if you hit it:** stop the daemon before `init --force` and let
running plugins drain (they hold the per-plugin lock for at most one run).
Documented in the daemon-reload note in `docs/cli/init.mdx`.

## 2. Library moved out from under config (`mv X Y` after init)

`config.json` records the canonical (realpath-resolved) library path at init
time. If the user later does `mv X Y` on disk, config still points at `X`.
`openStore()` calls `mkdirSync(root, { recursive: true })`, which silently
recreates an empty `X`. Subsequent `dither search` returns no results because
the new empty `X` has no collections.

**Why we accept it:** the same footgun existed in the pre-config layout. The
realpath canonicalisation covers the symlink-swap case (the more common one)
but not literal-move. Detecting "did this directory change since init" would
mean stat'ing inodes on every command, which doesn't earn its keep.

**Mitigation if you hit it:** either move it back, or `dither init --force
--library <new-path>` to rebuild config + index against the new location.

## 3. Concurrent config write/read

`saveConfig()` writes the whole file in one `writeFile` call. `loadConfig()`
reads with no flock. A read concurrent with a write could in theory observe
a torn JSON blob.

**Why we accept it:** config is a small file (few hundred bytes). The kernel
write is effectively atomic for that size. Adding flock for a v1 single-user
flow is overkill.

**Mitigation:** none planned. If we ever see flaky JSON-parse errors in
practice, switch to atomic write-temp-then-rename.

## 4. `dither daemon run` invoked directly without init

The `run` subcommand under `daemon` is the internal long-lived process the
daemon-control spawns detached. It does **not** call `assertInitialized`
because it's only ever invoked after `daemon start` has already done that
check.

**If a user runs `dither daemon run` by hand without `dither init`**: the
first `reconcile()` calls `resolveLibraryRoot()`, which throws
`NotInitializedError`, which crashes the daemon process. No PID file is
written; no harm.

**Why we accept it:** the public daemon entry point is `daemon start` and
that one is guarded. The internal `daemon run` is documented as hidden in
the citty `meta`. Adding a redundant guard would only catch a misuse path
that already fails fast.

## 5. Daemon doesn't auto-reload on `init --force`

A running daemon caches `state.scheduleCount` / `state.watchCount` and the
in-memory `Watcher` is bound to the library root resolved at last
`reconcile()`. After `init --force` rewrites config, the daemon keeps
operating against the old library until something triggers reconcile.

`reconcile()` is called on SIGHUP (which is what `dither daemon reload`
sends). It re-reads config and rebinds the watcher.

**Mitigation:** documented in `docs/cli/init.mdx` — "after `init --force`,
run `dither daemon reload` if the daemon is running."

We could make `init --force` itself send SIGHUP to the daemon. Parked as a
v2 ergonomic improvement.
