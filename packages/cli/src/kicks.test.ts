import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("kicks", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-kicks-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("writeKick writes the pending file at <home>/kicks/<plugin>.json", async () => {
    const { writeKick } = await import("./kicks");
    const payload = {
      runId: "20260525T120000-foo-deadbeef",
      kickedAt: "2026-05-25T12:00:00.000Z",
      overrides: { env: { TOKEN: "abc" } },
    };
    await writeKick("foo", payload);
    const raw = require("node:fs").readFileSync(join(home, "kicks", "foo.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(payload);
  });

  it("clearKick unlinks the file", async () => {
    const { writeKick, clearKick, hasKick } = await import("./kicks");
    await writeKick("foo", { runId: "r", kickedAt: "t" });
    await clearKick("foo");
    expect(hasKick("foo")).toBe(false);
  });

  it("clearKick is no-op on missing file", async () => {
    const { clearKick } = await import("./kicks");
    await expect(clearKick("nope")).resolves.toBeUndefined();
  });

  it("hasKick reports presence", async () => {
    const { writeKick, clearKick, hasKick } = await import("./kicks");
    expect(hasKick("foo")).toBe(false);
    await writeKick("foo", { runId: "r", kickedAt: "t" });
    expect(hasKick("foo")).toBe(true);
    await clearKick("foo");
    expect(hasKick("foo")).toBe(false);
  });

  it("rejects traversal segments in plugin names", async () => {
    const { writeKick, clearKick } = await import("./kicks");
    const p = { runId: "r", kickedAt: "t" };
    for (const bad of ["../escape", "/abs", "with/slash", "with\\back", "..", ".", ""]) {
      await expect(writeKick(bad, p)).rejects.toThrow(/invalid plugin name/);
      await expect(clearKick(bad)).rejects.toThrow(/invalid plugin name/);
    }
  });

  it("signalDaemon is a no-op when pid file is missing", async () => {
    const { signalDaemon } = await import("./kicks");
    expect(() => signalDaemon()).not.toThrow();
  });

  it("signalDaemon is a no-op when pid file points at a dead pid", async () => {
    const { signalDaemon } = await import("./kicks");
    writeFileSync(
      join(home, "dither.pid"),
      JSON.stringify({ pid: 2147483646, token: "x", startedAt: "t" }),
    );
    expect(() => signalDaemon()).not.toThrow();
  });

  it("signalDaemon sends SIGUSR1 to a live pid", async () => {
    const { signalDaemon } = await import("./kicks");
    let received = false;
    const onSig = (): void => {
      received = true;
    };
    process.on("SIGUSR1", onSig);
    try {
      writeFileSync(
        join(home, "dither.pid"),
        JSON.stringify({ pid: process.pid, token: "x", startedAt: "t" }),
      );
      signalDaemon();
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toBe(true);
    } finally {
      process.off("SIGUSR1", onSig);
    }
  });

  it("kickSource.drain fires each pending kick and clears the file", async () => {
    const { writeKick, kickSource, hasKick } = await import("./kicks");
    await writeKick("a", { runId: "r-a", kickedAt: "t1" });
    await writeKick("b", { runId: "r-b", kickedAt: "t2", overrides: { net: ["x.com"] } });
    const fired: Array<{ name: string; runId: string }> = [];
    const src = kickSource(async (name, payload) => {
      fired.push({ name, runId: payload.runId });
      return "done";
    });
    await src.drain();
    expect(fired).toEqual([
      { name: "a", runId: "r-a" },
      { name: "b", runId: "r-b" },
    ]);
    expect(hasKick("a")).toBe(false);
    expect(hasKick("b")).toBe(false);
  });

  it("kickSource.drain is a no-op when no kicks exist", async () => {
    const { kickSource } = await import("./kicks");
    let called = 0;
    const src = kickSource(async () => {
      called += 1;
      return "done";
    });
    await src.drain();
    expect(called).toBe(0);
  });

  it("kickSource.recover re-queues an inflight kick left by a crashed daemon and fires it", async () => {
    const { kickSource } = await import("./kicks");
    // Plant an orphan inflight kick (claimed but never acked).
    mkdirSync(join(home, "kicks", "inflight"), { recursive: true });
    writeFileSync(
      join(home, "kicks", "inflight", "ghost.json"),
      `${JSON.stringify({ runId: "r-ghost", kickedAt: "t" })}\n`,
    );
    const fired: string[] = [];
    const src = kickSource(async (name) => {
      fired.push(name);
      return "done";
    });
    await src.recover(() => undefined);
    expect(fired).toEqual(["ghost"]);
    expect(existsSync(join(home, "kicks", "inflight", "ghost.json"))).toBe(false);
    expect(existsSync(join(home, "kicks", "ghost.json"))).toBe(false);
  });

  it("kickSource start/stop registers and removes a SIGUSR1 drain", async () => {
    const { writeKick, kickSource, hasKick } = await import("./kicks");
    const fired: string[] = [];
    const src = kickSource(async (name) => {
      fired.push(name);
      return "done";
    });
    src.start();
    try {
      await writeKick("sig", { runId: "r-sig", kickedAt: "t" });
      process.kill(process.pid, "SIGUSR1");
      // SIGUSR1 + async drain — poll until the kick clears.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && hasKick("sig")) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(fired).toEqual(["sig"]);
    } finally {
      src.stop();
    }
  });
});
