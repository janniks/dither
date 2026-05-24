import { readDaemonPid, startDaemon } from "./daemon-control";
import { isPidAlive } from "./locks";
import { followGlobal, globalLogSize, type LogEvent } from "./run-log";

/**
 * Client of the long-lived Daemon process. Wraps the SIGHUP-trigger +
 * Run-log follow + dead-PID probe + signal-handler housekeeping so
 * callers see a single async iterable of operationally-meaningful
 * events.
 *
 * Three methods:
 *   - signalReconcile() — write-semantic. Starts the daemon if needed,
 *     sends SIGHUP, returns the daemon's PID.
 *   - watchReconcile()  — read-semantic. Pure observer over the
 *     **Run-log** global scope. Never spawns. Yields a filtered, closed
 *     `DaemonEvent` union; completes on `reconcile-done`; throws on
 *     `daemon-stopped` mid-reconcile, on `DaemonDiedError` (PID goes
 *     ESRCH), or on caller-aborted signal.
 *   - triggerAndWatch() — convenience composition. Signals first, then
 *     yields from watchReconcile.
 *
 * DI-style transport hook: tests pass a stub transport (controllable
 * event iterable + fake pid/alive impl) to drive the seam without
 * spawning a real daemon. Production callers omit it.
 */

/** Operationally-meaningful event kinds the renderer cares about. */
export type DaemonEvent =
  | (LogEvent & { kind: "job-started" })
  | (LogEvent & { kind: "job-progress" })
  | (LogEvent & { kind: "job-done" })
  | (LogEvent & { kind: "job-failed" })
  | (LogEvent & { kind: "job-skipped" })
  | (LogEvent & { kind: "model-download-progress" })
  | (LogEvent & { kind: "reconcile-done" });

const RENDERABLE: ReadonlySet<string> = new Set([
  "job-started",
  "job-progress",
  "job-done",
  "job-failed",
  "job-skipped",
  "model-download-progress",
  "reconcile-done",
]);

export class DaemonStoppedDuringReconcileError extends Error {
  constructor() {
    super("daemon stopped mid-reconcile");
    this.name = "DaemonStoppedDuringReconcileError";
  }
}

export class DaemonDiedError extends Error {
  constructor() {
    super("daemon process is no longer alive");
    this.name = "DaemonDiedError";
  }
}

export class DaemonReconcileFailedError extends Error {
  constructor(reason: string) {
    super(`daemon reconcile failed: ${reason}`);
    this.name = "DaemonReconcileFailedError";
  }
}

/**
 * Transport surface — the seams between daemon-client and the world.
 * In production the default values close over `daemon-control` and
 * `run-log`. Tests substitute everything for deterministic stubs.
 */
export interface DaemonTransport {
  readDaemonPid(): Promise<number | null>;
  startDaemon(): Promise<{ pid: number }>;
  follow(signal: AbortSignal, fromOffset?: number): AsyncIterable<LogEvent>;
  isAlive(pid: number): boolean;
  signal(pid: number, sig: "SIGHUP"): void;
  /**
   * Current byte size of the global Run-log. `triggerAndWatch` snapshots
   * this BEFORE sending SIGHUP and passes the value to `follow`'s
   * `fromOffset` — guarantees a `reconcile-started` event emitted
   * between SIGHUP delivery and the follower's `open()` is still inside
   * the read window.
   */
  snapshotOffset(): Promise<number>;
}

const defaultTransport: DaemonTransport = {
  readDaemonPid,
  startDaemon: async () => {
    const r = await startDaemon();
    return { pid: r.pid };
  },
  follow: (signal, fromOffset) => followGlobal(signal, fromOffset),
  isAlive: isPidAlive,
  signal: (pid, sig) => process.kill(pid, sig),
  snapshotOffset: globalLogSize,
};

export interface SignalReconcileResult {
  triggered: true;
  pid: number;
}

export interface WatchOptions {
  signal?: AbortSignal;
  /** PID of the daemon to probe for liveness. If omitted, read it. */
  pid?: number;
  /**
   * Byte offset to start following from. `triggerAndWatch` passes the
   * pre-SIGHUP snapshot so a fast daemon can't write `reconcile-started`
   * before the follower opens. Direct callers omit it (follow from EOF).
   */
  fromOffset?: number;
}

export interface DaemonClient {
  signalReconcile(): Promise<SignalReconcileResult>;
  watchReconcile(opts?: WatchOptions): AsyncIterable<DaemonEvent>;
  triggerAndWatch(opts?: { signal?: AbortSignal }): AsyncIterable<DaemonEvent>;
}

export function daemonClient(opts: { transport?: DaemonTransport } = {}): DaemonClient {
  const t = opts.transport ?? defaultTransport;

  async function signalReconcile(): Promise<SignalReconcileResult> {
    let pid = await t.readDaemonPid();
    if (pid === null) {
      const started = await t.startDaemon();
      pid = started.pid;
    }
    t.signal(pid, "SIGHUP");
    return { triggered: true, pid };
  }

  async function* watchReconcile(watchOpts: WatchOptions = {}): AsyncGenerator<DaemonEvent> {
    const pid = watchOpts.pid ?? (await t.readDaemonPid());
    if (pid === null) throw new DaemonDiedError();

    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    watchOpts.signal?.addEventListener("abort", onAbort, { once: true });

    // 100ms probe matches the Run-log poll cadence so dead-PID
    // detection is no slower than event delivery.
    let dead = false;
    const timer = setInterval(() => {
      if (!t.isAlive(pid)) {
        dead = true;
        ac.abort();
      }
    }, 100);

    let started = false;
    let stopped = false;
    let failure: string | null = null;
    let aborted = false;

    try {
      for await (const event of t.follow(ac.signal, watchOpts.fromOffset)) {
        if (event.kind === "reconcile-started") {
          started = true;
          continue;
        }
        if (!started) continue;
        if (event.kind === "daemon-stopped") {
          stopped = true;
          break;
        }
        if (event.kind === "reconcile-failed") {
          failure = typeof event.error === "string" ? event.error : "unknown";
          break;
        }
        if (event.kind === "reconcile-done") {
          if (RENDERABLE.has(event.kind)) yield event as DaemonEvent;
          return;
        }
        if (RENDERABLE.has(event.kind)) yield event as DaemonEvent;
      }
    } finally {
      clearInterval(timer);
      watchOpts.signal?.removeEventListener("abort", onAbort);
      if (watchOpts.signal?.aborted && !dead) aborted = true;
      ac.abort();
    }

    if (dead) throw new DaemonDiedError();
    if (stopped) throw new DaemonStoppedDuringReconcileError();
    if (failure !== null) throw new DaemonReconcileFailedError(failure);
    if (aborted) return;
    // Iterator ended without reconcile-done and without a known reason;
    // treat as silent drop and surface as died.
    throw new DaemonDiedError();
  }

  async function* triggerAndWatch(opts: { signal?: AbortSignal } = {}): AsyncGenerator<DaemonEvent> {
    // Resolve pid first (may start the daemon) but do NOT send SIGHUP yet.
    // The daemon's SIGHUP handler can emit `reconcile-started` before
    // the follower's open() completes — open()-at-EOF would then miss
    // the event, cycleStarted would never flip, and the iterator would
    // hang. Snapshotting the log size before SIGHUP and pinning the
    // follower to that offset closes the window.
    let pid = await t.readDaemonPid();
    if (pid === null) {
      const started = await t.startDaemon();
      pid = started.pid;
    }
    const fromOffset = await t.snapshotOffset();
    t.signal(pid, "SIGHUP");
    yield* watchReconcile({ signal: opts.signal, pid, fromOffset });
  }

  return { signalReconcile, watchReconcile, triggerAndWatch };
}
