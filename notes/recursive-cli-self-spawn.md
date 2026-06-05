# Recursive CLI / self-spawn for background work

We run heavy/background work by **re-exec'ing our own binary** with a
(usually hidden) subcommand, coordinating purely through **files + locks**
— no shared mutable memory. Already in use: `startDaemon()` spawns
`process.execPath [argv1, "daemon", "run"]` (`daemon-control.ts:166-181`);
the off-thread qmd reconcile (`daemon reconcile`) extends the same shape.

## This is an established pattern

Common names: **re-exec / self-exec**, **multi-call binary** (argv[0]
dispatch), **role-flagged subprocess**.

Closest analogues (re-exec self with a role):
- **Chromium / Electron** — same binary respawned as `--type=renderer`,
  `--type=gpu`, `--type=utility`. The canonical example. Crash isolation +
  fresh address space.
- **Docker/Moby `reexec`** — daemon re-execs `argv[0]` into named init
  funcs for namespace setup; coordinates via pipes + state files.
- **`runc init` / containerd-shim / gVisor `runsc boot`** — re-exec into a
  clean single-threaded child before privileged/namespace work.
- **systemd** — re-execs itself on live upgrade, handing state via an fd in
  argv.

Related but distinct:
- **fork-without-exec** (Postgres backends, nginx workers) — supervisor/
  worker shape, *not* re-exec. (Postgres on Windows *does* re-exec
  `postgres --boot` because no `fork()` — same native-unsafety driver.)
- **multi-call binary** (BusyBox) — one binary, many tools via argv[0].
- **plugin-over-RPC** (Hashicorp go-plugin) — separate binaries, same
  isolation motive.

Why people reach for it: clean state isolation, crash isolation,
privilege separation, and **working around native/thread-unsafety** —
which is exactly our `node-llama-cpp` + `better-sqlite3` case.

## Verdict on our flavor

Spawn self with a hidden subcommand to run a long background job,
coordinating through files + locks, full process isolation — **idiomatic
and sound**. Our prior art (`daemon run`) is already a textbook instance.

Pitfalls, and where we stand:
- **Orphan/zombie reaping** → detached spawn + PID file (have it).
- **Signal propagation** (`setsid`, forwarding SIGTERM) → existing daemon
  spawn handles detach; reconcile child gets SIGTERM-drained on shutdown
  (plan P4).
- **Version skew** (binary replaced on disk mid-run) → our `{pid, token,
  startedAt}` PID-file triple-match is the standard mitigation. Already
  doing the right thing.
- **Self-path resolution** → use `process.execPath` + `process.argv[1]`,
  not bare `argv[0]` (matches `daemon-control.ts:166-167`).
- **Debugging opacity** → set `process.title` on the child so it shows up
  legibly in `ps`. (TODO in plan P1.)

Reusable as our general "run something in the background" mechanism:
expose internal processes as top-level (hidden) commands with their own
isolated state; when they mutate, they work on files and use locks to
avoid overlap/races.
