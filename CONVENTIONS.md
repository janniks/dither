# Conventions

> Read in full before implementing. Last full scan: 2026-07-13 @ d6e3f3b.

## Naming

| Kind | Convention | Example |
|------|-----------|---------|
| files | kebab-case noun(-noun); test sibling `<file>.test.ts`, same dir | `run-log.ts`, `daemon-control.ts` |
| command files | `command-<name>.ts`; family shares prefix | `command-plugin-run.ts` |
| exported functions | verb-first, short camelCase | `claimInbox`, `readGrants`, `promote` |
| path getters | `<thing>Path()` / `<thing>Dir()`, all in `paths.ts` | `pidFilePath`, `grantsDirPath` |
| command exports | `<name>Command` / `<name>Subcommand` (citty consts) | `pluginCommand`, `runSubcommand` |
| internals/locals | single word; brevity over disambiguation | `pid`, `cfg`, `raw`, `row`, `child` |
| types | PascalCase noun; suffixes `Options`, `Result`, `State`, `Stats` — use `Options`, not `Opts` | `RunOptions`, `StartResult` |
| classes | PascalCase noun, singular, no Manager/Service suffix | `Scheduler`, `Queue` |
| error classes | `<Reason>Error` extends Error, sets `this.name` | `DaemonDiedError`, `InstallCancelledError` |
| error tags | exported SCREAMING string const when one code is enough | `PLUGIN_NOT_INSTALLED`, `FDA_REQUIRED` |
| constants | SCREAMING_SNAKE; time keeps its unit suffix | `SHUTDOWN_GRACE_MS`, `POISON_PILL_THRESHOLD` |
| time-typed values | keep `Ms`/`Sec`/`At` suffix everywhere | `timeoutMs`, `lastFetchAt` |
| union `kind` strings | kebab / verb-noun, never camelCase | `"ok-cleared"`, `"reconcile-done"` |
| test-only escape hatches | `_` prefix | `_resetMarkersMigrationLatch` |
| test doubles | `fake<Thing>` / `stub<Thing>` factory returning double + inspection hooks | `fakeSpawn`, `stubTransport` |
| env vars | `DITHER_<NOUN>`, defined in one record literal | `DITHER_RUN_DIR` |
| CLI flags | kebab-case, args keys mirror the flag verbatim | `args["dry-run"]`, `args["allow-net"]` |

## Shape

| Pattern | Convention | Example |
|---------|-----------|---------|
| exports | named only, never default | everywhere |
| params | one options object for multi-arg exports; access via dot, don't destructure | `runPlugin(opts)` → `opts.name` |
| types placement | declared directly above the function using them; no central types file | `RunDecision` above `decideRunOutcome` |
| classes | only when mutable session state is unavoidable; else plain functions | `Watcher` vs `search()` |
| factories | closure + object literal for stateless modules | `kickSource(fire)`, `daemonClient()` |
| pure/IO split | pull the pure half out, name it `plan*`/`decide*`/`parse*`, unit-test it | `plan()`, `decideRunOutcome`, `parseDownloadSummary` |
| testability seams | injectable I/O as an options field defaulting to the real thing — never module mocks | `spawn = nodeSpawn`, `ExchangeOpts.fetch` |
| outcomes | discriminated unions / typed results over thrown control flow | `Outcome = "done" \| "retry"` |
| config mutation | pure — return the new object, caller persists | `addExternal(cfg, ...)` |
| module docs | every file opens with a why-block, often citing a spec/note/sibling | `queue.ts`, `watch-state.ts` |
| commands | `defineCommand({meta, args, run})`; dispatcher at bottom of file; big families split one file per subcommand + `command-<group>-shared.ts` for cross-imports | `command-plugin.ts` |
| command guard | `await assertInitialized()` first line of any run touching config/library | `command-search.ts` |
| heavy deps | dynamic `await import(...)` to defer natives, with a comment | `command-daemon.ts` reconcile |

## In code

- Early returns, no `else`. `const` over `let`; ternaries over reassignment. Render-state `if/else if` chains are the one tolerated exception.
- Single-word locals; inline values used once (`await readFile(path.join(dir, "journal.json"), "utf-8")` — no `journalPath` variable).
- Avoid `any`; rely on inference, annotate only exports.
- Prefer `flatMap`/`filter`/`map` over loops; type guards on filter.
- Two ENOENT idioms, picked by where the boundary lives — never `.catch(() => null)` on a primary read path:
  - function IS the I/O boundary → try/catch, return `null`/`[]` on ENOENT, rethrow the rest (`readRefire`)
  - best-effort side work → `.catch(() => undefined)` (`requestReindex().catch(() => undefined)`)
- try/finally for guaranteed cleanup (run dirs, locks, scratch dirs) — not try/catch control flow.
- Atomic state writes: tmp file (pid/random suffix, same dir — same filesystem, EXDEV) + `rename`.
- Validate everything before touching disk; two-pass plan/act so partial application is impossible (`promotion.ts`, `planInstall`).
- Bounded retries (small fixed count, comment why) — never unbounded; poll loops use a `Date.now()` deadline, 25–250ms tick.
- Locks return `null` for "didn't get it" — caller decides the fallback (defer via marker, wait, skip). `isPidAlive` is the only liveness probe.
- Timers that shouldn't hold the process open get `.unref()`.
- Set dedup via `Array.from(new Set([...]))` when layering grant/config lists.
- Comments explain why — invariants, rejected alternatives, upstream citations — never what the next line does.
- Operational logs: `console.error` prefixed `[daemon]`/module name; never throw across a fire boundary.
- User-facing success lines: lowercase, terse, no trailing period (`removed x`); end with a `next:`/`hint:` nudge when there's an obvious follow-up. Exit codes: 1 failure, 2 usage/precondition, 130 user cancel.
- Machine-output commands write all human text to stderr, payload only to stdout; read commands offering both take `--json` and short-circuit before formatting.

### Tests

- No mocks. Real temp dirs: `mkdtempSync(join(tmpdir(), "dither-<feature>-test-"))`, `process.env.DITHER_DIR` swapped in `beforeEach`, restored-or-deleted + `rmSync` in `afterEach`.
- Dynamic `await import(...)` inside tests for modules that resolve env-derived paths; `vi.resetModules()` when module state must reset. Static imports for pure modules.
- Drive CLI tests through `runCommand(main, {rawArgs})`, not subcommand internals. Capture output by spying both `console.log` and `process.stdout.write` (each test file keeps its own local `captureLogs` — deliberate, don't extract).
- `it` names are full behavior sentences; `toMatch` regex for human output, exact `toEqual` for structured data. Table-driven cases (`it.each` or a cases array) for pure functions.
- Stub only true process/network boundaries (transport, spawn, fetch) via the injectable seams above.

## Vocabulary

Terms the code already uses consistently — reuse them, don't invent new ones.

| Term | Meaning |
|------|---------|
| source | fire producer with the uniform `start/recover/stop/stats` shape |
| fire | one call through the choke point (`makeFire`); outcome `"done" \| "retry"` |
| kick | pending manual run trigger file; CLI writes, daemon consumes |
| claim / ack / restore | at-least-once queue lease lifecycle (inbox, kicks) |
| marker | single-purpose flag file under `markers/`, consumed atomically |
| theme | qmd lock category (`download\|index\|embed`) |
| grants / consent / widen | persisted permissions; consent = user's opt-in vs manifest's ask; widen = exceeding the ask, never silent |
| plan | the pure precomputation half, separated from the act |
| promote | copy validated run outputs into the library (two-pass) |
| journal | append-only per-run event log (`RunHandle`) |
| sink | pluggable reporting surface (`journalSink`, `stderrSink`) |
| reconcile | the daemon's index+embed cycle, bookended `reconcile-started`/`-done` |
| tail | follow a run's live journal to completion |
| busy | a lock already held; always paired with a deferral marker |
| detach | return now, daemon keeps going |
| poison pill / suspended | 3 consecutive failures halt refire until a manual run succeeds |
| hand-off | daemon self-restart on stale build: quiet → drain → spawn → confirm → exit |

## CLI / TUI

All interactive output goes through `packages/cli/src/prompt.ts`. Don't pull in
new prompt or spinner deps — extend that module. Existing deps: `consola`
(prompts), `picocolors` (color), `node:readline` (cursor moves). Colors used:
`dim`, `green`, `yellow`, `cyan`, `bold` — nothing else.

- **Prompts (`promptText`)** — one line; bake hints into the message in parens.
- **Confirmation (`confirm(label, value)`)** — immediately after the prompt resolves; rewrites the echoed line to `✓ Label: value`.
- **Progress (`stepStart`/`stepDone`/`stepFail`)** — bracket every step that can take more than a beat. The user must never wonder whether the CLI is hung. `→`/`✓` lines stay in scrollback as the post-hoc log; no end-of-run summary block. Glyphs are fixed vocabulary: `→` dim in-progress, `✓` green done, `⚠` yellow fail.
- Instant operations use plain `console.log` — don't bracket them.
- TTY vs non-TTY is a first-class branch wherever terminal output exists (pipe safety, CI); gate prompts on `stdin.isTTY && stdout.isTTY` with a plain-print fallback.
- Plugin-supplied text is untrusted: only `pluginText` (via `untrusted-text.ts`) may print it; nothing else in `packages/cli/` reads `manifest.*.description` straight to stdout.
- `tildePath` is display-only — never persist the abbreviated form.

## Project Patterns

Cross-cutting idioms in `packages/cli/src/` for daemon + plugin
coordination. New IPC channels should mirror these shapes; new daemon code
should slot into the existing seams. Refs are `file.ts:functionName`.

It's okay to question these, especially during refactors, but try to find
new abstractions and rules that are simple and work across the whole
codebase to simplify our understanding and the visual representation of
how the whole system works. The whole system works together as one thing.

### The shape

Everything lives under the config dir (`paths.ts:configDir()`;
`$DITHER_DIR` → `$XDG_CONFIG_HOME/dither` → `~/.dither`). One layout, one language. New IPC channels become another
directory of the same shape.

```
<config>/                     # e.g. ~/.dither
├── dither.pid                # {pid, token, startedAt}
├── status.json               # event-driven snapshot (not periodic)
├── run-log.jsonl             # global events; trunc on daemon start
├── env.json                  # globalEnv (grants.envRefs targets)
├── qmd-index.sqlite
├── markers/
│   ├── needs-reindex         # request marker
│   └── embed-disabled        # state marker
├── logs/daemon.log
├── bin/                      # managed deno
├── plugins/<name>/           # installed plugin + state/
├── grants/<plugin>.json      # consented permissions
├── locks/
│   ├── <plugin>.lock         # body: holder PID
│   ├── qmd-{download,index,embed}.lock
│   └── daemon-start.lock
├── refires/<plugin>.json     # plugin reschedule + retry
├── inboxes/<plugin>.ndjson   # watch events queued
├── inflight/<plugin>.ndjson  # claimed but unfinished
├── kicks/                    # pending manual run triggers
├── schedule-state/           # per-plugin lastRun timestamps
├── watch-state/              # per-plugin mtime watermarks
├── jobs/<jobId>.json         # qmd inflight snapshots
├── history/<runId>/          # per-run journal
│   ├── manifest.json         # identity (+ childPid post-spawn)
│   ├── events.jsonl          # progress/stderr/added/reschedule
│   └── result.json           # terminal (ok/fail); tmp+rename
└── runs/<runId>/             # ephemeral sandbox; rm-rf'd in finally
```

Fire sources funnel through one choke point:

```
Scheduler (cron)                    ─┐
Watcher (native watch-tree → inbox) ─┼─→ fire(name, trigger, kick?)
Refirer (timer-per-row)             ─┼     1. LoopDetector.shouldHalt? retry
Kicks (manual run triggers)         ─┘     2. await runPlugin({name, trigger})
                                           3. watcher.suppressOnce(added paths)
                                           4. pick up any refire row the run wrote
                                           5. postRun → re-drain pending kicks
```

`makeFire(state, deps)` builds the choke point (`daemon.ts:makeFire`);
busy/halted fires return `"retry"` so kicks stay pending instead of being
dropped. Sources don't import `runPlugin` — the callback is the seam; the
`set/stop/stats` shapes are deliberately identical (`scheduler.ts:Scheduler`,
`watcher.ts:Watcher`, `refirer.ts:Refirer`).

Signals: `SIGTERM`/`SIGINT` → graceful shutdown with a 30s child-drain
window; `SIGHUP` → reload config/grants/refires + qmd reconcile.

**Filesystem channels.** One file per identity, body is JSON (or NDJSON
when append-heavy). API is uniformly `read/write/clear/list`. Atomic
tmp+rename where readers race writers (`run-log.ts:openRun` — result.json
and manifest); plain `writeFile` where partial reads are tolerable.
Listing is `readdir` with `ENOENT → []`. Plugin-name safety asserted at
write (`refire.ts:assertSafePluginName`). Secrets go through
`writePrivateJson` (0700 dir / 0600 file, `secure-json.ts`).

**Grants.** One `Grants` type + `readGrants`/`writeGrants`/`listGrants`
(`grants.ts`). `readGrants` returns null on missing file, throws on corrupt
JSON, normalizes `create`/`edit`/`net` to `[]`, and preserves unknown fields
across read-modify-write. The daemon reads top-level `schedule`/`watch`
(consented), never `manifest.schedule`/`watch` (declared).

**Daemon lifecycle.** `runDaemon()` writes the PID file, truncates the
global run-log, clears stale `jobs/`, restores orphan `inflight/`, then
arms all sources via `armSources()` (`daemon.ts:runDaemon`). No periodic
heartbeat: the status snapshot is rewritten only on real events — startup,
SIGHUP reload, run start/end, loop-detector halt, shutdown — via a
`writeStatus` closure threaded through the fire sources as a `notify`
callback (`daemon.ts:writeStatusSnapshot`). Shutdown verifies its own
`{pid, token}` against the PID file before unlinking — a respawned
daemon's file is never clobbered (`daemon.ts:removePidFile`); PID files
parse through one strict `parsePidFile` (`paths.ts:parsePidFile`). CLI
auto-starts the daemon via `ensureDaemonForPlugin` after install/consent
re-grant for plugins with `schedule` or `watch`
(`command-plugin-shared.ts:ensureDaemonForPlugin`); `startDaemon()` is
itself gated by `acquire("daemon-start")` to serialize spawns
(`daemon-control.ts:startDaemon`).

**Locks.** O_EXCL `open(path, "wx")`, retry up to 3× with `isPidAlive`
probe on `EEXIST` (`locks.ts:acquire`). Two surfaces over the same code:
named locks (`acquire("name")` for plugins, daemon-start) and typed
themes (`acquireTheme("download"|"index"|"embed")` → `qmd-<theme>` on
disk). Read-side `status(theme)` returns `{startedAt, pid}` only for
live holders (`locks.ts:status`); `holders()` enumerates live plugin
locks (`locks.ts:holders`). Index rescans outside the daemon go through
`reindex()` — acquire the index lock or defer via the needs-reindex
marker (`update-index.ts:reindex`).

**Run journal.** Lifecycle: `openRun(plugin, trigger)` → `setChildPid`
(post-spawn) → `append({kind, ...})` per event → `close({status,
finishedAt, ...})` (`run-log.ts:openRun`). Run-id is sortable:
`YYYYMMDDTHHMMSS-<safe-plugin>-<4byte-hex>`. Status inference
(`readSummary`): `result.json` present → that status; missing + `childPid`
dead → `interrupted`; else → `running` (`run-log.ts:readSummary`).
`followRun`/`followGlobal` poll+stat (no `fs.watch`) and survive rotation
via dev/inode (`run-log.ts:followRun`, `followGlobal`).

**Daemon liveness.** Liveness is the PID file + `kill(pid, 0)` + token
match — nothing time-based. The status snapshot is opportunistic context,
NOT a liveness signal: an idle daemon legitimately leaves it old, so
staleness never implies death (`status` shows "updated 3m ago" so the
user judges freshness by relative time). `probeDaemon()` walks PID-file
exists → `kill(0)` alive → snapshot `pid/token/startedAt` matches, and
surfaces the first failing gate as a typed reason (`no-pidfile`,
`bad-pidfile`, `dead-process`, `snapshot-mismatch`;
`daemon-control.ts:probeDaemon`). A live daemon with no snapshot yet still
reports `reason: null`.

**Plugin process model.** A pure `plan()` builds the whole spawn — Deno
args, env, `input.json` body — from resolved grants
(`plugin-run.ts:plan`). The `DITHER_*` env contract
(`DITHER_{RUN_DIR,INPUT_FILE,STATE_FILE,TRIGGER,PLUGIN_NAME}`) and the
`--allow-env` list derive from one record so they can't diverge.
`runPluginLocked` writes `runs/<runId>/input.json` plus an import map,
then spawns Deno with `--allow-{read,write,env,net}` from the plan
(`plugin-run.ts:runPluginLocked`). NDJSON control messages on stderr —
`_dither: "progress"` / `"reschedule"` parsed defensively by
`parseControl`; last reschedule wins (`supervisor.ts:parseControl`);
other stderr lines journal as `{kind: "stderr"}`. On clean exit,
`promote()` validates each `runs/<runId>/*.md` (`source === plugin`,
`collection ∈ grants`) before moving them into the library
(`promotion.ts:promote`) — soft conflicts are skipped + journaled, never
thrown. `runs/<runId>` is always `rm -rf`-ed in `finally` so plaintext
secrets in `input.json` don't linger (`plugin-run.ts:runPluginLocked`).

**Inbox / inflight — at-least-once.** Watcher appends NDJSON rows into
`inboxes/<plugin>.ndjson`. Fire start: `claimInbox` atomically
`rename(inbox → inflight)`, reads, dedups by path keeping latest mtime
(`inbox.ts:claimInbox`). Clean run → `clearInflight`; any failure path →
`restoreInflight` appends rows back to inbox (`inbox.ts:clearInflight`,
`restoreInflight`). Startup `recoverOrphanInflight()` restores files left
by a crashed prior daemon (`inbox.ts:recoverOrphanInflight`). Both inbox
and kicks are thin renames over `Queue<T>` (`queue.ts`) — latest-wins vs
log/dedup are the two canonical storage shapes.

**Refire decision (pure).** `decideRunOutcome({exitCode, rescheduleMs,
prior})` returns `ok-cleared | ok-rescheduled | failed-retry |
failed-suspended` (`refire.ts:decideRunOutcome`). Failures backoff 1m then
5m; `POISON_PILL_THRESHOLD = 3` consecutive non-clean exits → `suspended:
true` until a manual run succeeds. `setTimeout` delays past 32-bit max
chunk-and-reschedule (`refirer.ts:scheduleAt`).

**Loop detector.** Chain-depth count keyed on `triggerSource`
(`"scheduled:foo"`). `DEFAULT_THRESHOLD = 3`, `DEFAULT_TTL_MS = 30_000`;
post-TTL triggers are fresh roots. `shouldHalt` true when `depth + 1 >
threshold`. Halts → bounded ring (cap 16), surfaced via
`status.recentHalts.slice(0, 5)`. In-memory; resets on daemon restart
(`loop-detector.ts:shouldHalt`).

**Markers.** Single-purpose flag files at `<config>/markers/<name>`
(`markers.ts`). `needs-reindex`: any non-daemon writer calls
`requestReindex()`; daemon coalesces via atomic `rename → .processing →
unlink` so requests arriving mid-cycle aren't lost
(`markers.ts:claimReindex`). `embed-disabled`: written by `disableEmbed()`
/ `enableEmbed()`; checked by the reconciler between embed iterations
(`markers.ts:readMarkerState`). The reconciler is stateless w.r.t. work
intent — markers + SQLite state are the source of truth.

**CLI ↔ daemon kick-and-watch.** `daemonClient.triggerAndWatch()` is the
canonical pattern: snapshot global-log byte offset → send SIGHUP →
follow log from the pinned offset (`daemon-client.ts:triggerAndWatch`).
Pinning closes the race where `reconcile-started` is emitted before the
follower opens. `watchReconcile` yields a filtered `DaemonEvent` union,
terminates on `reconcile-done`, throws typed errors for stopped/failed/died
(`daemon-client.ts:watchReconcile`). Seams hidden behind a `DaemonTransport`
interface so tests substitute deterministic stubs. Reconcile child failures
travel the same wire — `{_dither: "job-failed"|"reconcile-failed", error}`
(`reconcile-sink.ts:stderrSink`, `reconcile-supervisor.ts:reconcileHandler`).
The child reports intent; the daemon owns the journal.

**SQLite / qmd.** All native-store access goes through `openStore()`
(`store.ts`) — no module touches `@tobilu/qmd` directly.

## Tidbits

- Anacron-style catch-up: `recover()` re-derives owed work from durable
  watermarks (`lastRun`, mtime) instead of replaying missed ticks —
  `scheduler.ts`, `watcher.ts`.
- Watcher invalidates stale async callbacks with a generation counter
  bumped on `stop()`/`set()` — check `gen` before acting (`watcher.ts`).
- Re-entrancy gates are a single boolean set synchronously before any
  `await` (`state.handingOff`, `daemon.ts`).
- Monotonic guard before writing watermark state: `if (next <= stored)
  return` (`watch-state.ts`, `schedule-state.ts` — the two files mirror
  each other on purpose).
- Baked build stamp vs disk sidecar (`build-stamp.ts`): computed once in
  the tsdown hook so they can never disagree; staleness drives daemon
  hand-off.
- Small duplications are deliberate (no-DRY stance): per-test-file
  `captureLogs`, `assertSafePluginName` in both `refire.ts` and
  `kicks.ts`. Don't extract shared helpers for these.
- Cancellation from consola is detected by message-matching, not a typed
  error — known compromise, commented at the sites.
- deprecated aliases are kept one release, marked `@deprecated`, then
  removed (`home`/`DITHER_HOME` are gone; the concept is `configDir`).
