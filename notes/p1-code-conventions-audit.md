# P1: Code conventions audit — drift & cleanups

Deep audit of `packages/cli/src/` (+ `packages/plugin/src/`). Headline: deep modules follow AGENTS.md cleanly; drift lives in the presentation layer (commands, status formatters) and a few hard files (`promotion.ts`, `daemon-client.ts`).

## Top patterns (confirmed)

- **Classes only for state.** 6 non-error classes total. Triad `Scheduler` / `Watcher` / `Refirer` mirror each other (`set/stop/stats`) so `daemon.ts:210-220` consumes them through one shape. `LoopDetector`, `ProgressLine`, `QmdDownloadCapture` carry per-instance state. Everything else is module-of-functions — `Supervisor` and `Promotion` extracted as one-shot functions, not classes (commits `49ce473`, `9f81462`).
- **Filesystem channels are a family resemblance, not a real abstraction.** AGENTS.md oversells uniform `read/write/clear/list` — `inbox.ts` has no `read` (atomic-move), `locks.ts` uses `acquire/release/status`. Consistent within: scalars → `null` on ENOENT, lists → `[]`; JSON one-per-file, NDJSON append-heavy; read-side liveness probes sync (`hasKick`, `isLockHeld`, `status`).
- **Discriminated unions with `kind:` discriminator** — `RunDecision`, `DaemonEvent`, `ControlMessage`, `PlanResult`. No shared `Result<T>`; each module rolls its own.
- **Zero `any`, zero `satisfies`, zero `T`-prefix.** `JSON.parse(...) as Record<string, unknown>` is the canonical foreign-data shape.

## Real inconsistencies

1. **Two ENOENT idioms, ~30 sites each.** Try/catch with `code === "ENOENT"` (`refire.ts:42`, `inbox.ts:30`, `kicks.ts:47`, `locks.ts:101`) vs `.catch(() => null)` (`daemon.ts:122,128,208,296,382`, `plugin-run.ts:104+`, `run-log.ts:282,321,348`). Roughly: try/catch when this function *is* the boundary; `.catch` when caller is doing best-effort cleanup. Coherent but undocumented.
2. **`else` lives in the presentation layer.** 36 `} else` total. Deep modules (`locks`, `refire`, `inbox`, `kicks`, `grants`, `promotion`, `supervisor`) have **zero**. 8 each in `commands/init.ts` and `commands/status.ts`. `commands/status.ts:34-42` is a 4-level nested ternary. `promotion.ts:85-93` is a 3-level ternary with embedded `(() => { throw })()` IIFE — single most surprising expression in the repo.
3. **`daemon-control.ts` vs `daemon-client.ts`** — sibling files with overlapping verbs. Names don't tell you which side of the wire. Practice: control = local-process helper (pid file, spawn); client = event-stream RPC wrapper.
4. **`commands/plugin.ts` is 785 LOC** — by far largest non-test file. Dispatcher *and* `handleProtectedInstall` (`:186`) *and* inline run-tailing (`:684-713`). Sibling `init.ts` 415, `status.ts` 143. Catch-all drift.
5. **`commands/index.ts` is the `dither index` command, not a barrel.** `cli.ts` is a 5-line bootstrap. Two names collide with JS expectations.
6. **`acquire(name)` vs `acquireTheme(theme)`** — same on-disk format, two surfaces. `status(theme)` only works for themes; `isLockHeld(name)` for named. Easy to grab the wrong reader.
7. **`run-log.ts` keeps `queues` and `sizes` as module-level `Map`s** (`:114, :119`). Two daemons in one process (tests!) silently share state. `truncateGlobal` resets `sizes` but not `queues` (`:176`). Asymmetric with the `Scheduler`/`Watcher`/`Refirer` classes — "classes when state" rule bent here.
8. **`home()` reads `process.env` at every call** (`home.ts:26`). Tests need `await import("./home")` after mutating `DITHER_DIR`. `_resetHomeWarningLatch` (`:37`) exists for tests only.
9. **`fireWithSuppress` tail-recurses on watch triggers** (`daemon.ts:127-130`). Reads like unbounded loop; `LoopDetector` is the actual guard. Surprising on first read.

## Naming verdict

- Brevity rule **holds** in deep modules (`pid`, `cfg`, `dir`, `row`, `raw`, `entry`, `lock`). Multi-word violations cluster in orchestrators (`lastReportedBucket`, `pluginTextLinesAbove`, `holderPid`, `defaultTransport`) — almost all defensible.
- Time-typed suffixes **consistent**: `HEARTBEAT_MS`, `SUPPRESS_TTL_MS`, `etaSec`, `kickedAt`, `mtimeMs`.
- Function naming: verb-first dominant; minor drift `locks.ts:184 status()` (noun) vs `daemon.ts:191 readStatusSnapshot()` (verb) — same op, two styles.
- Constants: SCREAMING_SNAKE for thresholds/timeouts, camelCase for frozen-data singletons. `RENDERABLE` / `DEFAULT_GLOB` (`daemon-client.ts:37, 89`) sit on the seam.
- Type suffix conventions loose: `*Options` / `*Result` / `*Entry` / `*Row` applied by author taste.

## Confusion hotspots for a new contributor (ranked)

1. `commands/index.ts` is the `index` command, not a barrel.
2. `home()` reads env every call — tests need dynamic imports.
3. Two ENOENT idioms with no documented rule.
4. `acquire` vs `acquireTheme` dual surfaces over one impl.
5. `promotion.ts:85-93` IIFE-in-ternary.
6. `fireWithSuppress` tail-recursion guarded only by `LoopDetector`.
7. `run-log.ts` module-level `Map`s leak across daemon instances.

## Cleanup candidates (drift, not deliberate)

Ranked by impact:

1. **Split `commands/plugin.ts`** — extract `handleProtectedInstall` and run-tailing into peer files.
2. **Rewrite `promotion.ts:85-93`** as early-return helper — kills worst expression in repo.
3. **Document the ENOENT rule** (try/catch in I/O modules, `.catch` in cleanup paths) — or pick one.
4. **Rename `commands/index.ts`** — eliminates permanent paper cut.
5. **`commands/status.ts:34-42`** — replace 4-level ternary with lookup or early returns.
6. **Promote `run-log.ts` to a class** — symmetric with `Scheduler`/`Watcher`/`Refirer`, fixes test-state leak.
7. **`scheduler.ts:39-48` adjacent try/catches** — fold into `parseSchedule(): {ok,value} | {ok:false,reason}`, mirroring `decideRunOutcome` (`refire.ts:99`).
8. **`daemon-client.ts:147-158` five `let` flags** — promote to typed state-machine local.

Items 1–4 high-impact; rest polish.

## Per-dimension highlights

### OO vs functional
- Lifecycle/callback triad deliberately symmetric — strongest pattern in the codebase.
- `LoopDetector` could be module-of-functions (only one instance, lives on daemon) but mild.
- `run-log.ts` module-level `queues`/`sizes` is the reverse drift — should arguably be a class.

### Module shape
- Deep: `run-log.ts` (580 LOC), `daemon.ts` (417), `daemon-jobs.ts` (449), `locks.ts` (204), `plugin-run.ts` (320 — essay-as-function).
- Shallow: `home.ts` (102 LOC, 13 one-line exports), `cli.ts` (5 LOC pointless re-export).
- Awkward middles: `commands/plugin.ts` (785), `plugin-install-interactive.ts` (625), `daemon-control.ts`/`daemon-client.ts` sibling overlap.

### Error handling
- 71 `try {` blocks; almost all are genuine boundaries (ENOENT probes, `JSON.parse` of foreign data, subprocess capture).
- Few avoidable: `scheduler.ts:39, 48` (user-config parsing — could be `Result` returner), `daemon-control.ts:172, 216, 236` (`process.kill` — actually necessary for ESRCH/EPERM).

### Async
- 6 `Promise.all` sites, all appropriate.
- One missed parallelism: `inbox.ts:148-163` `recoverOrphanInflight` serial — practically nil since daemon-startup only.
- `for await` universal for async iterators.
- `AbortSignal` threaded consistently through follow stack (`run-log.ts`, `daemon-client.ts`, `commands/init.ts`, `commands/plugin.ts`).

### Imports
- 154 relative imports; 2 alias imports (both `@tobilu/qmd`). No `@/` configured.
- No cross-package type imports between `cli/` and `plugin/` — only runtime `import.meta.resolve("@dither/plugin")` in `plugin-run.ts:226-227`.
- No circular hints in sampled grep.

### Comments
- JSDoc header on every important module explaining *intent and invariant* (not API).
- Inline comments heavy on *why*, almost no *what*. Convention is well-held.
