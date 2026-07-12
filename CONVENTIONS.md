# CONVENTIONS

> Agents: read this in full before implementing any feature. Naming above all.

## Style Guide

### General principles (TypeScript)

> THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Keep things in one function unless composable or reusable
- Avoid try/catch where possible
- Avoid using the `any` type
- Prefer single-word variable names where possible
- Rely on type inference; avoid explicit type annotations unless necessary for exports or clarity
- Prefer functional array methods (`flatMap`, `filter`, `map`) over for loops
- Prefer `const` over `let`. Use ternaries or early returns instead of reassignment
- Avoid `else` statements. Prefer early returns
- Avoid unnecessary destructuring. Use dot notation to preserve context
- Reduce variable count by inlining when a value is only used once
- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Examples to avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.
- Time-typed names keep their unit suffix: `MIN_DELAY_MS`, `timeoutMs`, `lastFetchAt`.

```ts
// Good
const foo = 1;
function journal(dir: string) {}

// Bad
const fooBar = 1;
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const data = await fs.readFile(path.join(dir, "journal.json"), "utf-8");

// Bad
const journalPath = path.join(dir, "journal.json");
const data = await fs.readFile(journalPath, "utf-8");
```

#### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a;
obj.b;

// Bad
const { a, b } = obj;
```

#### Variables

Always use `const` over `let`/`var`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2;

// Bad
let foo;
if (condition) foo = 1;
else foo = 2;
```

#### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1;
  return 2;
}

// Bad
function foo() {
  if (condition) return 1;
  else return 2;
}
```

#### I/O patterns

Two ENOENT-tolerant idioms coexist. Pick the one matching where the
boundary lives, not by author taste.

- **`try/catch` when the function IS the I/O boundary** — a reader whose
  job is to return `null` / `[]` for "file missing":

```ts
// Good — readRefire is the boundary
export async function readRefire(plugin: string): Promise<RefireRow | null> {
  try {
    const raw = await readFile(refirePath(plugin), "utf-8");
    return JSON.parse(raw) as RefireRow;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
```

- **`.catch(() => null)` (or `.catch(() => undefined)`) when the caller is
  doing best-effort cleanup** — the I/O is a side concern, not the
  function's purpose:

```ts
// Good — caller doesn't care if the marker write fails
await writeFile(needsReindexPath(), "", "utf-8").catch(() => undefined);
```

Don't use `.catch(() => null)` to silence errors on a primary read path —
you lose the distinction between "missing file" and "real I/O failure."

### Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests

## CLI / TUI

All interactive output goes through `packages/cli/src/prompt.ts`. Don't pull in
new prompt or spinner deps — extend that module instead. Existing deps:
`consola` (prompts), `picocolors` (color), `node:readline` (cursor moves).

**Prompts (`promptText`).** One line. Bake any hint into the message in
parens — e.g. `Where should your library live? (ENTER for ~/.dither/library)`.
Don't stack a second hint line below; it clutters the rewrite zone.

**Confirmation (`confirm(label, value)`).** Call immediately after the prompt
resolves. It rewrites consola's echoed prompt line to `✓ Label: value`, so the
answer reads as "locked in" and the question disappears from scrollback.

**Progress (`stepStart` / `stepDone` / `stepFail`).** Bracket every step that
can take more than a beat — index walks, network fetches, model downloads.
Pattern:

```ts
stepStart("downloading model weights (first run, may take a minute)...");
const result = await prefetchWeights();
if (result.ok) stepDone("downloaded model weights");
else stepFail(`weight prefetch failed: ${result.reason}`);
```

The user must never wonder whether the CLI is hung. Both `→` and `✓` lines
stay in scrollback — they're the post-hoc log of what the command did, so
there's no separate end-of-run summary block. End with one blank line and a
single `next: <command>` nudge if there's an obvious follow-up.

Tests capturing output: spy both `console.log` and `process.stdout.write`
(see `init.test.ts` → `captureLogs`). The prompt helpers write directly to
stdout to keep cursor control intact.

## Project Patterns

Cross-cutting idioms in `packages/cli/src/` for daemon + plugin
coordination. New IPC channels should mirror these shapes; new daemon code
should slot into the existing seams. Refs are `file.ts:functionName`.

It's okay to question these, especially during refactors, but try to find
new abstractions and rules that are simple and work across the whole
codebase to simplify our understanding and the visual representation of
how the whole system works. The whole system works together as one thing.

### The shape

Everything lives under `<home>` (defaults to `~/.config/dither`,
`home.ts`). One layout, one language. New IPC channels become another
directory of the same shape.

```
<home>/                       # ~/.config/dither
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
Refirer (timer-per-row)             ─┘     1. LoopDetector.shouldHalt? retry
Kicks (manual run triggers)         ─┘     2. await runPlugin({name, trigger})
                                           3. watcher.suppressOnce(added paths)
                                           4. pick up any refire row the run wrote
                                           5. postRun → re-drain pending kicks
```

`makeFire(state, deps)` builds the choke point (`daemon.ts:makeFire`);
busy/halted fires return `"retry"` so kicks stay pending instead of being
dropped. Sources don't import `runPlugin` — the callback is the seam; the
three `set/stop/stats` shapes are deliberately identical
(`scheduler.ts:Scheduler`, `watcher.ts:Watcher`, `refirer.ts:Refirer`).

Signals: `SIGTERM`/`SIGINT` → graceful shutdown with a 30s child-drain
window; `SIGHUP` → reload config/grants/refires + qmd reconcile.

**Filesystem channels.** One file per identity, body is JSON (or NDJSON
when append-heavy). API is uniformly `read/write/clear/list`. Atomic
`writeFile(tmp) + rename` for tmp+rename where readers race writers
(`run-log.ts:openRun` — result.json and manifest); plain `writeFile` where
partial reads are tolerable. Listing is `readdir` with `ENOENT → []`.
Plugin-name safety asserted at write (`refire.ts:assertSafePluginName`).

**Grants.** One `Grants` type + `readGrants`/`writeGrants`/`listGrants`
(`grants.ts`). `readGrants` returns null on missing file, throws on corrupt
JSON, normalizes `create`/`edit`/`net` to `[]`, and preserves unknown fields
across read-modify-write.

**Daemon lifecycle.** `runDaemon()` writes the PID file, truncates the
global run-log, clears stale `jobs/`, restores orphan `inflight/`, then
arms all sources via `armSources()` (`daemon.ts:runDaemon`). No periodic
heartbeat: the status snapshot is rewritten only on real events — startup,
SIGHUP reload, run start/end, loop-detector halt, shutdown — via a
`writeStatus` closure threaded through the fire sources as a `notify`
callback (`daemon.ts:writeStatusSnapshot`). Shutdown verifies its own
`{pid, token}` against the PID file before unlinking — a respawned
daemon's file is never clobbered (`daemon.ts:removePidFile`); PID files
parse through one strict `parsePidFile` (`home.ts:parsePidFile`). CLI
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
`_dither: "progress"` / `"reschedule"` parsed by `parseControl`
(`supervisor.ts:parseControl`); other stderr lines journal as
`{kind: "stderr"}`. On clean exit, `promote()` validates each
`runs/<runId>/*.md` (`source === plugin`, `collection ∈ grants`) before
moving them into the library (`promotion.ts:promote`). `runs/<runId>` is
always `rm -rf`-ed in `finally` so plaintext secrets in `input.json`
don't linger (`plugin-run.ts:runPluginLocked`).

**Inbox / inflight — at-least-once.** Watcher appends NDJSON rows into
`inboxes/<plugin>.ndjson`. Fire start: `claimInbox` atomically
`rename(inbox → inflight)`, reads, dedups by path keeping latest mtime
(`inbox.ts:claimInbox`). Clean run → `clearInflight`; any failure path →
`restoreInflight` appends rows back to inbox (`inbox.ts:clearInflight`,
`restoreInflight`). Startup `recoverOrphanInflight()` restores files left
by a crashed prior daemon (`inbox.ts:recoverOrphanInflight`).

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

**Markers.** Single-purpose flag files at `<home>/markers/<name>`
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
