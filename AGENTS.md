# AGENTS.md

> **Simple made easy.** Rich Hickey / Steve Jobs style. Every change should make the system simpler, not just add to it.

- Functional, idiomatic, well-abstracted
- Simplify the plan first, then make notes on how to edit
- No premature abstractions/DRY (it's overrated)
- Prefer deleting code over adding code
- No over-engineering, no speculative features
- If it's not clearly needed right now, don't build it

## Generic agent management

### Format

- All work in md files, in-repo. No GitHub issues unless explicitly asked.
- Short bullets, few full sentences. Readable at 1/4 desktop width or on mobile.
- Commit after each meaningful change.

### Dirs

- `specs/` — feature intent (problem, stories, decisions). 1:1 by name with `plans/`. In-progress drafts suffixed `-DRAFT.md`.
- `plans/` — phased implementation. Active plan suffixed `-RUNNING.md` (contains an inline phase-log table).
- `notes/` — flat, unstructured scratchpad. One thought per file. Revisit only on request.
- `docs/` — stable reference (style guide, architecture).

### Flow

- `/grill-me` → `/create-spec` → `/create-plan` → implement phase-by-phase → commit per phase.
- In-progress artifacts are suffixed: `specs/<feature>-DRAFT.md` while interviewing, `plans/<feature>-RUNNING.md` while implementing. Rename back (drop the suffix) on finalize / completion.
- Tick acceptance criteria and append a phase-log row inside the `-RUNNING.md` plan after each commit.
- Deferred items: front-matter `status: deferred` on whatever file fits. No dedicated dir.

### Git

- **Never rewrite git history.** No `rebase -i`, no `--amend` of an existing commit, no `filter-branch`, no `rebase --exec` that amends, no `reset --hard` over commits, no force-push. Rewriting risks silently dropping work — including in-progress `specs/`, `plans/`, and `notes/` md files that aren't tracked anywhere else. Fix mistakes with a new follow-up commit (or `git revert`). If a commit must be reworked, ask first.
- Toolchain is npm with workspaces. Only `package-lock.json` at the repo root is committed; no per-package lockfiles, no `pnpm-lock.yaml` or `yarn.lock`.
- `~/.npmrc` enforces `min-release-age=7` (no deps published in the last 7 days) and `ignore-scripts=true` for security. Native modules (e.g. `better-sqlite3`) need their install scripts run manually — invoke `npm run install` inside the package dir when a binding is missing.

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
should slot into the existing seams. Refs are `file:line`.

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
├── status.json               # 1Hz snapshot
├── run-log.jsonl             # global events; trunc on daemon start
├── env.json                  # globalEnv (grants.envRefs targets)
├── qmd-index.sqlite
├── needs-reindex             # marker
├── embed-disabled            # marker
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
├── jobs/<jobId>.json         # qmd inflight snapshots
├── history/<runId>/          # per-run journal
│   ├── manifest.json         # identity (+ childPid post-spawn)
│   ├── events.jsonl          # progress/stderr/added/reschedule
│   └── result.json           # terminal (ok/fail); tmp+rename
└── runs/<runId>/             # ephemeral sandbox; rm-rf'd in finally
```

Fire sources funnel through one choke point:

```
Scheduler (cron)            ─┐
Watcher (chokidar → inbox)  ─┼─→ fireWithSuppress(name, trigger)
Refirer (timer-per-row)     ─┘     1. LoopDetector.shouldHalt? skip
                                   2. await runPlugin({name, trigger})
                                   3. watcher.suppressOnce(added paths)
                                   4. pick up any refire row the run wrote
```

Sources don't import `runPlugin` — the callback is the seam; the three
`set/stop/stats` shapes are deliberately identical (`scheduler.ts:32-82`,
`watcher.ts:73-132`, `refirer.ts:22-77`, `daemon.ts:210-220`).

Signals: `SIGTERM`/`SIGINT` → graceful shutdown with a 30s child-drain
window; `SIGHUP` → reload config/grants/refires + qmd reconcile.

**Filesystem channels.** One file per identity, body is JSON (or NDJSON
when append-heavy). API is uniformly `read/write/clear/list`. Atomic
`writeFile(tmp) + rename` for tmp+rename where readers race writers
(`run-log.ts:477-487`); plain `writeFile` where partial reads are
tolerable. Listing is `readdir` with `ENOENT → []`. Plugin-name safety
asserted at write (`refire.ts:36-40`).

**Daemon lifecycle.** `runDaemon()` writes the PID file, truncates the
global run-log, clears stale `jobs/`, restores orphan `inflight/`, then
reconciles (`daemon.ts:233-261`). 1s `setInterval` heartbeat rewrites
`status.json` (`daemon.ts:26, 314-316`). Shutdown verifies its own
`{pid, token}` against the PID file before unlinking — a respawned
daemon's file is never clobbered (`daemon.ts:115-125`). CLI auto-starts
the daemon via `ensureDaemonForPlugin` after install/consent re-grant for
plugins with `schedule` or `watch` (`commands/plugin.ts:221-256`);
`startDaemon()` is itself gated by `acquire("daemon-start")` to serialize
spawns (`daemon-control.ts:156-205`).

**Locks.** O_EXCL `open(path, "wx")`, retry up to 3× with `isPidAlive`
probe on `EEXIST` (`locks.ts:62-125`). Two surfaces over the same code:
named locks (`acquire("name")` for plugins, daemon-start) and typed
themes (`acquireTheme("download"|"index"|"embed")` → `qmd-<theme>` on
disk). Read-side `status(theme)` returns `{startedAt, pid}` only for
live holders (`locks.ts:165-178`).

**Run journal.** Lifecycle: `openRun(plugin, trigger)` → `setChildPid`
(post-spawn) → `append({kind, ...})` per event → `close({status,
finishedAt, ...})` (`run-log.ts:440-489`, `plugin-run.ts:452-459`).
Run-id is sortable: `YYYYMMDDTHHMMSS-<safe-plugin>-<4byte-hex>`. Status
inference (`readSummary`): `result.json` present → that status; missing
+ `childPid` dead → `interrupted`; else → `running`
(`run-log.ts:531-567`). `followRun`/`followGlobal` poll+stat (no
`fs.watch`) and survive rotation via dev/inode (`run-log.ts:264-350`).

**Status snapshot freshness.** Read-side `probeDaemon()` requires both a
15s freshness window AND a `pid/token/startedAt` triple-match against
the PID file; mismatches surface as typed reasons (`no-pidfile`,
`dead-process`, `snapshot-stale`, etc., `daemon-control.ts:30-126`).

**Plugin process model.** `runPlugin` writes `runs/<runId>/input.json`
(`{trigger, env, files, targets, net}`) plus an import map, then `spawn`
Deno with `--allow-{read,write,env,net}` derived from grants (per-run
overrides layered on top) (`plugin-run.ts:342-452`). SDK env contract:
`DITHER_{RUN_DIR,INPUT_FILE,STATE_FILE,TRIGGER,PLUGIN_NAME}`
(`plugin-run.ts:65-72`). NDJSON control messages on stderr — `_dither:
"progress"` / `"reschedule"` parsed by `parseControl`
(`plugin-run.ts:104-129`); other stderr lines journal as
`{kind: "stderr"}`. On clean exit, `planPromotion` validates each
`runs/<runId>/*.md` (`source === plugin`, `collection ∈ grants`) before
`copyAdded` moves them into the library. `runs/<runId>` is always
`rm -rf`-ed in `finally` so plaintext secrets in `input.json` don't
linger (`plugin-run.ts:565-568`).

**Inbox / inflight — at-least-once.** Watcher appends NDJSON rows into
`inboxes/<plugin>.ndjson`. Fire start: `claimInbox` atomically
`rename(inbox → inflight)`, reads, dedups by path keeping latest mtime
(`inbox.ts:82-108`). Clean run → `clearInflight`; any failure path →
`restoreInflight` appends rows back to inbox (`plugin-run.ts:258, 275`).
Startup `recoverOrphanInflight()` restores files left by a crashed prior
daemon (`inbox.ts:148-164`).

**Refire decision (pure).** `decideRunOutcome({exitCode, rescheduleMs,
prior})` returns `ok-cleared | ok-rescheduled | failed-retry |
failed-suspended` (`refire.ts:93-148`). Failures backoff 1m then 5m;
`POISON_PILL_THRESHOLD = 3` consecutive non-clean exits → `suspended:
true` until a manual run succeeds. `setTimeout` delays past 32-bit max
chunk-and-reschedule (`refirer.ts:59-83`).

**Loop detector.** Chain-depth count keyed on `triggerSource`
(`"scheduled:foo"`). `DEFAULT_THRESHOLD = 3`, `DEFAULT_TTL_MS = 30_000`;
post-TTL triggers are fresh roots. `shouldHalt` true when `depth + 1 >
threshold`. Halts → bounded ring (cap 16), surfaced via
`status.recentHalts.slice(0, 5)`. In-memory; resets on daemon restart
(`loop-detector.ts:47-72`).

**Markers.** Single-purpose flag files at `<home>/<marker>`.
`needs-reindex`: any non-daemon writer touches it; daemon coalesces via
atomic `rename → .processing → unlink` so requests arriving mid-cycle
aren't lost (`daemon-jobs.ts:241-259`). `embed-disabled`: checked between
embed iterations (`daemon-jobs.ts:270`). The reconciler is stateless
w.r.t. work intent — markers + SQLite state are the source of truth.

**CLI ↔ daemon kick-and-watch.** `daemonClient.triggerAndWatch()` is the
canonical pattern: snapshot global-log byte offset → send SIGHUP →
follow log from the pinned offset (`daemon-client.ts:197-212`). Pinning
closes the race where `reconcile-started` is emitted before the follower
opens. `watchReconcile` yields a filtered `DaemonEvent` union, terminates
on `reconcile-done`, throws typed errors for stopped/failed/died
(`daemon-client.ts:137-195`). Seams hidden behind a `DaemonTransport`
interface so tests substitute deterministic stubs.
