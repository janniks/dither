import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { RunHandle } from "./run-log";

interface JournalEvent {
  kind: string;
  [key: string]: unknown;
}

/**
 * Minimal in-memory journal. Matches the shape supervise consumes —
 * `setChildPid` + `append`. Records every interaction so tests can
 * assert exact sequences.
 */
function fakeJournal(): { handle: RunHandle; events: JournalEvent[]; pid: number | null } {
  const events: JournalEvent[] = [];
  let pid: number | null = null;
  const handle: RunHandle = {
    runId: "test-run",
    dir: "/tmp/test-run",
    async append(event) {
      events.push(event as JournalEvent);
    },
    async close() {
      // unused
    },
    async setChildPid(p) {
      pid = p;
    },
  };
  return {
    handle,
    events,
    get pid() {
      return pid;
    },
  } as { handle: RunHandle; events: JournalEvent[]; pid: number | null };
}

/**
 * Build a fake spawn that returns a controllable child. The caller
 * drives stderr writes + close timing via the returned helpers.
 */
function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
    pid: number;
  };
  child.stderr = new PassThrough();
  child.pid = 4242;
  const spawn = ((cmd: string, args: string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, child, calls };
}

describe("supervise", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-supervise-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("passes denoPath, denoArgs, env, and inheriting stdio to spawn", async () => {
    const { supervise } = await import("./supervisor");
    const j = fakeJournal();
    const f = fakeSpawn();

    const run = supervise({
      denoPath: "/fake/deno",
      denoArgs: ["run", "--allow-read=/", "plugin.ts"],
      env: { FOO: "bar" } as NodeJS.ProcessEnv,
      journal: j.handle,
      spawn: f.spawn,
    });
    setImmediate(() => {
      f.child.stderr.end();
      f.child.emit("close", 0);
    });
    const out = await run;

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.cmd).toBe("/fake/deno");
    expect(f.calls[0]!.args).toEqual(["run", "--allow-read=/", "plugin.ts"]);
    expect((f.calls[0]!.opts as { env: Record<string, string> }).env.FOO).toBe("bar");
    expect((f.calls[0]!.opts as { stdio: string[] }).stdio).toEqual(["inherit", "inherit", "pipe"]);
    expect(out.exitCode).toBe(0);
  });

  it("records the child PID via setChildPid", async () => {
    const { supervise } = await import("./supervisor");
    const j = fakeJournal();
    const f = fakeSpawn();
    f.child.pid = 9999;

    const run = supervise({
      denoPath: "/d",
      denoArgs: [],
      env: {} as NodeJS.ProcessEnv,
      journal: j.handle,
      spawn: f.spawn,
    });
    setImmediate(() => {
      f.child.stderr.end();
      f.child.emit("close", 0);
    });
    await run;
    // Setter is fire-and-forget — wait briefly for the queued microtask.
    await new Promise((r) => setImmediate(r));
    expect(j.pid).toBe(9999);
  });

  it("parses progress() control messages and journals them", async () => {
    const { supervise } = await import("./supervisor");
    const j = fakeJournal();
    const f = fakeSpawn();

    const run = supervise({
      denoPath: "/d",
      denoArgs: [],
      env: {} as NodeJS.ProcessEnv,
      journal: j.handle,
      spawn: f.spawn,
    });
    setImmediate(() => {
      f.child.stderr.write(
        JSON.stringify({ _dither: "progress", message: "step 1", done: 1, total: 3 }) + "\n",
      );
      f.child.stderr.end();
      f.child.emit("close", 0);
    });
    await run;
    // Drain any queued appends.
    await new Promise((r) => setImmediate(r));
    expect(j.events).toContainEqual({
      kind: "progress",
      message: "step 1",
      done: 1,
      total: 3,
    });
  });

  it("parses reschedule() control messages and surfaces lastReschedule", async () => {
    const { supervise } = await import("./supervisor");
    const j = fakeJournal();
    const f = fakeSpawn();

    const run = supervise({
      denoPath: "/d",
      denoArgs: [],
      env: {} as NodeJS.ProcessEnv,
      journal: j.handle,
      spawn: f.spawn,
    });
    setImmediate(() => {
      f.child.stderr.write(
        JSON.stringify({ _dither: "reschedule", afterMs: 1000, reason: "rate-limit" }) + "\n",
      );
      f.child.stderr.write(
        JSON.stringify({ _dither: "reschedule", afterMs: 5000 }) + "\n",
      );
      f.child.stderr.end();
      f.child.emit("close", 0);
    });
    const out = await run;
    // Last one wins.
    expect(out.lastReschedule).toEqual({ afterMs: 5000 });
  });

  it("journals non-control stderr lines as { kind: 'stderr' }", async () => {
    const { supervise } = await import("./supervisor");
    const j = fakeJournal();
    const f = fakeSpawn();

    const run = supervise({
      denoPath: "/d",
      denoArgs: [],
      env: {} as NodeJS.ProcessEnv,
      journal: j.handle,
      spawn: f.spawn,
    });
    setImmediate(() => {
      f.child.stderr.write("hello world\n");
      f.child.stderr.write("another line\n");
      f.child.stderr.end();
      f.child.emit("close", 0);
    });
    await run;
    await new Promise((r) => setImmediate(r));
    const lines = j.events
      .filter((e) => e.kind === "stderr")
      .map((e) => e.line);
    expect(lines).toEqual(["hello world", "another line"]);
  });

  it("returns the child's non-zero exit code without throwing", async () => {
    const { supervise } = await import("./supervisor");
    const j = fakeJournal();
    const f = fakeSpawn();

    const run = supervise({
      denoPath: "/d",
      denoArgs: [],
      env: {} as NodeJS.ProcessEnv,
      journal: j.handle,
      spawn: f.spawn,
    });
    setImmediate(() => {
      f.child.stderr.end();
      f.child.emit("close", 42);
    });
    const out = await run;
    expect(out.exitCode).toBe(42);
    expect(out.fdaPath).toBeNull();
  });

  it("rejects when spawn raises a child-process 'error' event", async () => {
    const { supervise } = await import("./supervisor");
    const j = fakeJournal();
    const f = fakeSpawn();

    const run = supervise({
      denoPath: "/d",
      denoArgs: [],
      env: {} as NodeJS.ProcessEnv,
      journal: j.handle,
      spawn: f.spawn,
    });
    setImmediate(() => {
      f.child.emit("error", new Error("spawn ENOENT"));
    });
    await expect(run).rejects.toThrow(/ENOENT/);
  });

  it("flushes the final non-newline-terminated stderr line on end", async () => {
    const { supervise } = await import("./supervisor");
    const j = fakeJournal();
    const f = fakeSpawn();

    const run = supervise({
      denoPath: "/d",
      denoArgs: [],
      env: {} as NodeJS.ProcessEnv,
      journal: j.handle,
      spawn: f.spawn,
    });
    setImmediate(() => {
      f.child.stderr.end("tail-no-newline");
      f.child.emit("close", 0);
    });
    await run;
    await new Promise((r) => setImmediate(r));
    const lines = j.events
      .filter((e) => e.kind === "stderr")
      .map((e) => e.line);
    expect(lines).toEqual(["tail-no-newline"]);
  });
});
