import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Item {
  path: string;
  v: number;
}

describe("Queue", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-queue-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("enqueue → drain → ack round-trip removes the inflight lease", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "ndjson", shape: "log" });
    await q.enqueue("p", { path: "/a", v: 1 });
    await q.enqueue("p", { path: "/b", v: 2 });

    const seen: Item[] = [];
    const processed = await q.drain("p", async (item) => {
      seen.push(item);
      return "done";
    });

    expect(seen.map((i) => i.path).toSorted()).toEqual(["/a", "/b"]);
    expect(processed).toHaveLength(2);
    expect(existsSync(join(home, "q", "p.ndjson"))).toBe(false);
    expect(existsSync(join(home, "q", "inflight", "p.ndjson"))).toBe(false);
  });

  it("restore-on-retry re-queues the items for the next drain", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "ndjson", shape: "log", key: (i) => i.path });
    await q.enqueue("p", { path: "/a", v: 1 });

    await q.drain("p", async () => "retry");
    // Item is back in pending, not lost.
    expect(existsSync(join(home, "q", "inflight", "p.ndjson"))).toBe(false);

    const seen: Item[] = [];
    await q.drain("p", async (item) => {
      seen.push(item);
      return "done";
    });
    expect(seen).toEqual([{ path: "/a", v: 1 }]);
  });

  it("restore-on-throw re-queues the items", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "ndjson", shape: "log" });
    await q.enqueue("p", { path: "/a", v: 1 });

    await q.drain("p", async () => {
      throw new Error("boom");
    });

    const seen: Item[] = [];
    await q.drain("p", async (item) => {
      seen.push(item);
      return "done";
    });
    expect(seen).toEqual([{ path: "/a", v: 1 }]);
  });

  it("recoverAll re-queues an orphaned inflight file left on disk", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "ndjson", shape: "log" });
    mkdirSync(join(home, "q", "inflight"), { recursive: true });
    writeFileSync(
      join(home, "q", "inflight", "p.ndjson"),
      `${JSON.stringify({ path: "/x", v: 9 })}\n`,
    );

    const recovered = await q.recoverAll();
    expect(recovered).toEqual(["p"]);
    expect(existsSync(join(home, "q", "inflight", "p.ndjson"))).toBe(false);

    const seen: Item[] = [];
    await q.drain("p", async (item) => {
      seen.push(item);
      return "done";
    });
    expect(seen).toEqual([{ path: "/x", v: 9 }]);
  });

  it("log shape dedups by key at claim, last wins", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "ndjson", shape: "log", key: (i) => i.path });
    await q.enqueue("p", { path: "/a", v: 1 });
    await q.enqueue("p", { path: "/a", v: 5 });
    await q.enqueue("p", { path: "/b", v: 2 });

    const seen: Item[] = [];
    await q.drain("p", async (item) => {
      seen.push(item);
      return "done";
    });
    expect(seen.toSorted((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "/a", v: 5 },
      { path: "/b", v: 2 },
    ]);
  });

  it("latest shape keeps at most one pending item, latest-wins", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "json", shape: "latest" });
    await q.enqueue("p", { path: "/a", v: 1 });
    await q.enqueue("p", { path: "/a", v: 2 });

    const seen: Item[] = [];
    await q.drain("p", async (item) => {
      seen.push(item);
      return "done";
    });
    expect(seen).toEqual([{ path: "/a", v: 2 }]);
    expect(existsSync(join(home, "q", "p.json"))).toBe(false);
  });

  it("latest restore does not clobber a newer pending kick", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "json", shape: "latest" });
    await q.enqueue("p", { path: "/old", v: 1 });
    // Drain fails (retry) but during the run a newer enqueue lands. The
    // restore must not overwrite the newer pending item.
    await q.drain("p", async () => {
      await q.enqueue("p", { path: "/new", v: 2 });
      return "retry";
    });

    const seen: Item[] = [];
    await q.drain("p", async (item) => {
      seen.push(item);
      return "done";
    });
    expect(seen).toEqual([{ path: "/new", v: 2 }]);
  });

  it("pendingNames lists identities with a pending file, sorted", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "json", shape: "latest" });
    await q.enqueue("bbb", { path: "/b", v: 1 });
    await q.enqueue("aaa", { path: "/a", v: 1 });
    expect(await q.pendingNames()).toEqual(["aaa", "bbb"]);
  });

  it("decoupled claim → ack removes the lease (run finishes out-of-band)", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "ndjson", shape: "log" });
    await q.enqueue("p", { path: "/a", v: 1 });

    const claimed = await q.claim("p");
    expect(claimed).toEqual([{ path: "/a", v: 1 }]);
    // Lease is held; pending is empty until ack/restore.
    expect(existsSync(join(home, "q", "p.ndjson"))).toBe(false);
    expect(existsSync(join(home, "q", "inflight", "p.ndjson"))).toBe(true);

    await q.ack("p");
    expect(existsSync(join(home, "q", "inflight", "p.ndjson"))).toBe(false);
    expect(await q.claim("p")).toEqual([]);
  });

  it("decoupled claim → restore re-queues for the next claim", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "ndjson", shape: "log", key: (i) => i.path });
    await q.enqueue("p", { path: "/a", v: 1 });

    await q.claim("p");
    await q.restore("p");
    expect(existsSync(join(home, "q", "inflight", "p.ndjson"))).toBe(false);
    expect(await q.claim("p")).toEqual([{ path: "/a", v: 1 }]);
  });

  it("custom inflightDir leases to a sibling dir (the inbox layout)", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "in", ext: "ndjson", shape: "log", inflightDir: "fl" });
    await q.enqueue("p", { path: "/a", v: 1 });
    await q.claim("p");
    expect(existsSync(join(home, "fl", "p.ndjson"))).toBe(true);
    expect(existsSync(join(home, "in", "inflight", "p.ndjson"))).toBe(false);
    expect(await q.recoverAll()).toEqual(["p"]);
    expect(await q.claim("p")).toEqual([{ path: "/a", v: 1 }]);
  });

  it("prefer comparator keeps the winner regardless of append order", async () => {
    const { Queue } = await import("./queue");
    // Keep the greater `v` even when the smaller is appended last.
    const q = new Queue<Item>({
      dir: "q",
      ext: "ndjson",
      shape: "log",
      key: (i) => i.path,
      prefer: (a, b) => (b.v > a.v ? b : a),
    });
    await q.enqueue("p", { path: "/a", v: 5 });
    await q.enqueue("p", { path: "/a", v: 1 });

    const seen: Item[] = [];
    await q.drain("p", async (item) => {
      seen.push(item);
      return "done";
    });
    expect(seen).toEqual([{ path: "/a", v: 5 }]);
  });

  it("rejects unsafe identities", async () => {
    const { Queue } = await import("./queue");
    const q = new Queue<Item>({ dir: "q", ext: "json", shape: "latest" });
    for (const bad of ["../x", "a/b", "..", "."]) {
      await expect(q.enqueue(bad, { path: "/a", v: 1 })).rejects.toThrow(/invalid queue identity/);
    }
  });
});
