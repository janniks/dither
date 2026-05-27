import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("writeKick + readKick round-trips the payload", async () => {
    const { writeKick, readKick } = await import("./kicks");
    const payload = {
      runId: "20260525T120000-foo-deadbeef",
      kickedAt: "2026-05-25T12:00:00.000Z",
      overrides: { env: { TOKEN: "abc" } },
    };
    await writeKick("foo", payload);
    expect(await readKick("foo")).toEqual(payload);
  });

  it("readKick returns null on missing file", async () => {
    const { readKick } = await import("./kicks");
    expect(await readKick("nope")).toBeNull();
  });

  it("clearKick unlinks the file", async () => {
    const { writeKick, clearKick, readKick } = await import("./kicks");
    await writeKick("foo", { runId: "r", kickedAt: "t" });
    await clearKick("foo");
    expect(await readKick("foo")).toBeNull();
  });

  it("clearKick is no-op on missing file", async () => {
    const { clearKick } = await import("./kicks");
    await expect(clearKick("nope")).resolves.toBeUndefined();
  });

  it("listKicks returns sorted entries", async () => {
    const { writeKick, listKicks } = await import("./kicks");
    await writeKick("bbb", { runId: "r2", kickedAt: "t" });
    await writeKick("aaa", { runId: "r1", kickedAt: "t" });
    const out = await listKicks();
    expect(out.map((e) => e.plugin)).toEqual(["aaa", "bbb"]);
  });

  it("listKicks returns [] when dir is missing", async () => {
    const { listKicks } = await import("./kicks");
    expect(await listKicks()).toEqual([]);
  });

  it("listKicks ignores non-json entries", async () => {
    const { writeKick, listKicks } = await import("./kicks");
    await writeKick("ok", { runId: "r", kickedAt: "t" });
    mkdirSync(join(home, "kicks"), { recursive: true });
    writeFileSync(join(home, "kicks", "junk.txt"), "not-json");
    const out = await listKicks();
    expect(out.map((e) => e.plugin)).toEqual(["ok"]);
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
    const { writeKick, readKick, clearKick } = await import("./kicks");
    const p = { runId: "r", kickedAt: "t" };
    for (const bad of ["../escape", "/abs", "with/slash", "with\\back", "..", ".", ""]) {
      await expect(writeKick(bad, p)).rejects.toThrow(/invalid plugin name/);
      await expect(readKick(bad)).rejects.toThrow(/invalid plugin name/);
      await expect(clearKick(bad)).rejects.toThrow(/invalid plugin name/);
    }
  });

  it("signalDaemon is a no-op when pid file is missing", async () => {
    const { signalDaemon } = await import("./kicks");
    expect(() => signalDaemon()).not.toThrow();
  });

  it("signalDaemon is a no-op when pid file points at a dead pid", async () => {
    const { signalDaemon } = await import("./kicks");
    // Pid 1 is `init` and we can't signal it from a test, so use a clearly
    // dead pid: spawn no-op + reap, then use that pid. Simpler: write a
    // non-existent very high pid; `process.kill` will return ESRCH which
    // signalDaemon swallows.
    writeFileSync(
      join(home, "dither.pid"),
      JSON.stringify({ pid: 2147483646, token: "x", startedAt: "t" }),
    );
    expect(() => signalDaemon()).not.toThrow();
  });

  it("scanKicks fires each pending kick and unlinks the file", async () => {
    const { writeKick, scanKicks, listKicks } = await import("./kicks");
    await writeKick("a", { runId: "r-a", kickedAt: "t1" });
    await writeKick("b", { runId: "r-b", kickedAt: "t2", overrides: { net: ["x.com"] } });
    const fired: Array<{ name: string; runId: string }> = [];
    await scanKicks((name, payload) => {
      fired.push({ name, runId: payload.runId });
    });
    expect(fired).toEqual([
      { name: "a", runId: "r-a" },
      { name: "b", runId: "r-b" },
    ]);
    expect(await listKicks()).toEqual([]);
  });

  it("scanKicks is a no-op when no kicks exist", async () => {
    const { scanKicks } = await import("./kicks");
    let called = 0;
    await scanKicks(() => {
      called += 1;
    });
    expect(called).toBe(0);
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
      // SIGUSR1 delivery is async — wait briefly for the handler to run.
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toBe(true);
    } finally {
      process.off("SIGUSR1", onSig);
    }
  });
});
