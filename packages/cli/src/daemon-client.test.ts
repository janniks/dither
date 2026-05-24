import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogEvent } from "./run-log";
import type { DaemonTransport } from "./daemon-client";

/**
 * Stub transport that drives the seam deterministically. Tests push events
 * via `emit(event)` and toggle daemon-liveness via `kill()`. The `follow`
 * iterable yields whatever was emitted, including events emitted after the
 * iterator started consuming.
 */
interface Stub {
  transport: DaemonTransport;
  emit: (event: Omit<LogEvent, "ts" | "scope">) => void;
  kill: () => void;
  readonly signals: Array<{ pid: number; sig: string }>;
  readonly startCalls: number;
}

function stubTransport(initialPid: number | null = 1234): Stub {
  const queue: LogEvent[] = [];
  let waker: (() => void) | null = null;
  const state = { alive: initialPid !== null, pid: initialPid, startCalls: 0 };
  const signals: Array<{ pid: number; sig: string }> = [];

  function emit(event: Omit<LogEvent, "ts" | "scope">): void {
    queue.push({ ...event, ts: new Date().toISOString(), scope: "global" } as LogEvent);
    if (waker) {
      const w = waker;
      waker = null;
      w();
    }
  }

  function kill(): void {
    state.alive = false;
  }

  const transport: DaemonTransport = {
    async readDaemonPid() {
      return state.pid;
    },
    async startDaemon() {
      state.startCalls++;
      state.pid = state.pid ?? 9999;
      state.alive = true;
      return { pid: state.pid };
    },
    isAlive() {
      return state.alive;
    },
    signal(p, s) {
      signals.push({ pid: p, sig: s });
    },
    async *follow(signal) {
      while (!signal.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          waker = resolve;
          const onAbort = (): void => {
            waker = null;
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
    async snapshotOffset() {
      return 0;
    },
  };

  return {
    transport,
    emit,
    kill,
    signals,
    get startCalls() {
      return state.startCalls;
    },
  };
}

describe("daemonClient", () => {
  // Quieten the dead-PID timer cadence across tests.
  beforeEach(() => undefined);
  afterEach(() => undefined);

  it("signalReconcile starts the daemon when none is running, then SIGHUPs it", async () => {
    const stub = stubTransport(null);
    const { daemonClient } = await import("./daemon-client");
    const client = daemonClient({ transport: stub.transport });

    const result = await client.signalReconcile();
    expect(result.triggered).toBe(true);
    expect(stub.startCalls).toBe(1);
    expect(stub.signals).toEqual([{ pid: result.pid, sig: "SIGHUP" }]);
  });

  it("signalReconcile reuses a live daemon (no start, just SIGHUP)", async () => {
    const stub = stubTransport(1234);
    const { daemonClient } = await import("./daemon-client");
    const client = daemonClient({ transport: stub.transport });

    const result = await client.signalReconcile();
    expect(result.pid).toBe(1234);
    expect(stub.startCalls).toBe(0);
    expect(stub.signals).toEqual([{ pid: 1234, sig: "SIGHUP" }]);
  });

  it("watchReconcile yields renderable events, filters internal events, completes on reconcile-done", async () => {
    const stub = stubTransport();
    const { daemonClient } = await import("./daemon-client");
    const client = daemonClient({ transport: stub.transport });

    const seen: string[] = [];
    const pump = (async () => {
      for await (const e of client.watchReconcile()) seen.push(e.kind);
    })();

    // Pre-cycle noise gets dropped.
    stub.emit({ kind: "daemon-started", pid: 1234 });
    // Cycle begins.
    stub.emit({ kind: "reconcile-started", cycleId: "c1" });
    stub.emit({ kind: "job-started", jobId: "j1", type: "indexing" });
    stub.emit({ kind: "job-progress", jobId: "j1", type: "indexing", current: 1, total: 2 });
    stub.emit({ kind: "job-done", jobId: "j1", type: "indexing" });
    stub.emit({ kind: "reconcile-done", cycleId: "c1", jobsRun: 1 });

    await pump;
    expect(seen).toEqual(["job-started", "job-progress", "job-done", "reconcile-done"]);
  });

  it("watchReconcile throws DaemonStoppedDuringReconcileError when daemon-stopped arrives mid-cycle", async () => {
    const stub = stubTransport();
    const { daemonClient, DaemonStoppedDuringReconcileError } = await import("./daemon-client");
    const client = daemonClient({ transport: stub.transport });

    const pump = (async () => {
      for await (const _ of client.watchReconcile()) void _;
    })();

    stub.emit({ kind: "reconcile-started", cycleId: "c1" });
    stub.emit({ kind: "job-started", jobId: "j1", type: "indexing" });
    stub.emit({ kind: "daemon-stopped", pid: 1234 });

    await expect(pump).rejects.toBeInstanceOf(DaemonStoppedDuringReconcileError);
  });

  it("watchReconcile throws DaemonDiedError when the daemon PID goes ESRCH", async () => {
    const stub = stubTransport();
    const { daemonClient, DaemonDiedError } = await import("./daemon-client");
    const client = daemonClient({ transport: stub.transport });

    const pump = (async () => {
      for await (const _ of client.watchReconcile()) void _;
    })();

    stub.emit({ kind: "reconcile-started", cycleId: "c1" });
    // Daemon disappears mid-cycle without sending daemon-stopped.
    stub.kill();

    await expect(pump).rejects.toBeInstanceOf(DaemonDiedError);
  });

  it("watchReconcile aborts cleanly on caller signal (no throw)", async () => {
    const stub = stubTransport();
    const { daemonClient } = await import("./daemon-client");
    const client = daemonClient({ transport: stub.transport });

    const ac = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const e of client.watchReconcile({ signal: ac.signal })) {
        seen.push(e.kind);
        if (seen.length >= 1) ac.abort();
      }
    })();

    stub.emit({ kind: "reconcile-started", cycleId: "c1" });
    stub.emit({ kind: "job-started", jobId: "j1", type: "indexing" });

    await pump; // returns cleanly — abort is a clean detach.
    expect(seen).toEqual(["job-started"]);
  });

  it("triggerAndWatch composes signal + watch in one call", async () => {
    const stub = stubTransport();
    const { daemonClient } = await import("./daemon-client");
    const client = daemonClient({ transport: stub.transport });

    const seen: string[] = [];
    const pump = (async () => {
      for await (const e of client.triggerAndWatch()) seen.push(e.kind);
    })();

    stub.emit({ kind: "reconcile-started", cycleId: "c1" });
    stub.emit({ kind: "reconcile-done", cycleId: "c1", jobsRun: 0 });
    await pump;

    expect(stub.signals).toEqual([{ pid: 1234, sig: "SIGHUP" }]);
    expect(seen).toEqual(["reconcile-done"]);
  });

  it("triggerAndWatch snapshots the log offset before sending SIGHUP", async () => {
    // Race protection: the daemon's SIGHUP handler can emit
    // `reconcile-started` before the follower opens. If snapshotOffset
    // doesn't run BEFORE signal, the iterator can hang waiting for an
    // event that already landed below the open() byte position.
    const stub = stubTransport();
    const calls: string[] = [];
    const transport = {
      ...stub.transport,
      snapshotOffset: async (): Promise<number> => {
        calls.push("snapshotOffset");
        return 0;
      },
      signal: (p: number, s: "SIGHUP"): void => {
        calls.push("signal");
        stub.transport.signal(p, s);
      },
    };
    const { daemonClient } = await import("./daemon-client");
    const client = daemonClient({ transport });

    const pump = (async () => {
      for await (const _ of client.triggerAndWatch()) void _;
    })();

    stub.emit({ kind: "reconcile-started", cycleId: "c1" });
    stub.emit({ kind: "reconcile-done", cycleId: "c1", jobsRun: 0 });
    await pump;

    expect(calls).toEqual(["snapshotOffset", "signal"]);
  });
});
