import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("inbox", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-inbox-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("appendToInbox writes one NDJSON row per call", async () => {
    const { appendToInbox } = await import("./inbox");
    await appendToInbox("p1", { path: "/a.md", mtime: "2026-05-13T00:00:00.000Z" });
    await appendToInbox("p1", { path: "/b.md", mtime: "2026-05-13T00:00:01.000Z" });
    const raw = readFileSync(join(home, "inboxes", "p1.ndjson"), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).path).toBe("/a.md");
  });

  it("claimInbox dedups by path keeping the latest mtime, writes inflight, truncates inbox", async () => {
    const { appendToInbox, claimInbox } = await import("./inbox");
    await appendToInbox("p1", { path: "/a.md", mtime: "2026-05-13T00:00:00.000Z" });
    await appendToInbox("p1", { path: "/a.md", mtime: "2026-05-13T00:00:05.000Z" });
    await appendToInbox("p1", { path: "/b.md", mtime: "2026-05-13T00:00:02.000Z" });

    const claimed = await claimInbox("p1");
    expect(claimed).toHaveLength(2);
    const a = claimed.find((t) => t.path === "/a.md")!;
    expect(a.mtime).toBe("2026-05-13T00:00:05.000Z");

    expect(readFileSync(join(home, "inboxes", "p1.ndjson"), "utf-8")).toBe("");

    const inflight = readFileSync(join(home, "inflight", "p1.ndjson"), "utf-8");
    const rows = inflight.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
  });

  it("clearInflight removes the inflight file on clean exit", async () => {
    const { appendToInbox, claimInbox, clearInflight } = await import("./inbox");
    await appendToInbox("p1", { path: "/a.md", mtime: "2026-05-13T00:00:00.000Z" });
    await claimInbox("p1");
    expect(existsSync(join(home, "inflight", "p1.ndjson"))).toBe(true);
    await clearInflight("p1");
    expect(existsSync(join(home, "inflight", "p1.ndjson"))).toBe(false);
  });

  it("restoreInflight appends inflight rows back to inbox and deletes inflight", async () => {
    const { appendToInbox, claimInbox, restoreInflight, claimInbox: claim2 } = await import("./inbox");
    await appendToInbox("p1", { path: "/a.md", mtime: "2026-05-13T00:00:00.000Z" });
    await appendToInbox("p1", { path: "/b.md", mtime: "2026-05-13T00:00:01.000Z" });
    await claimInbox("p1");
    // Simulate a non-clean exit.
    await restoreInflight("p1");
    expect(existsSync(join(home, "inflight", "p1.ndjson"))).toBe(false);
    const claimed = await claim2("p1");
    expect(new Set(claimed.map((t) => t.path))).toEqual(new Set(["/a.md", "/b.md"]));
  });

  it("re-claim after restore + concurrent re-touch keeps the newer mtime", async () => {
    const { appendToInbox, claimInbox, restoreInflight } = await import("./inbox");
    await appendToInbox("p1", { path: "/a.md", mtime: "2026-05-13T00:00:00.000Z" });
    await claimInbox("p1");
    // Plugin crashes — but during the run, the file was re-touched. New
    // event lands in inbox with a newer mtime.
    await appendToInbox("p1", { path: "/a.md", mtime: "2026-05-13T01:00:00.000Z" });
    await restoreInflight("p1");
    const claimed = await claimInbox("p1");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.mtime).toBe("2026-05-13T01:00:00.000Z");
  });

  it("recoverOrphanInflight restores all orphan files and reports their plugin names", async () => {
    const { recoverOrphanInflight, claimInbox } = await import("./inbox");
    // Manually plant orphan inflight files (as if a daemon crashed mid-fire
    // before clearInflight or restoreInflight ran).
    mkdirSync(join(home, "inflight"), { recursive: true });
    writeFileSync(
      join(home, "inflight", "p1.ndjson"),
      `${JSON.stringify({ path: "/a.md", mtime: "2026-05-13T00:00:00.000Z" })}\n`,
    );
    writeFileSync(
      join(home, "inflight", "p2.ndjson"),
      `${JSON.stringify({ path: "/x.md", mtime: "2026-05-13T00:00:00.000Z" })}\n`,
    );

    const recovered = await recoverOrphanInflight();
    expect(new Set(recovered)).toEqual(new Set(["p1", "p2"]));
    expect(existsSync(join(home, "inflight", "p1.ndjson"))).toBe(false);
    expect(existsSync(join(home, "inflight", "p2.ndjson"))).toBe(false);

    const p1 = await claimInbox("p1");
    const p2 = await claimInbox("p2");
    expect(p1[0]!.path).toBe("/a.md");
    expect(p2[0]!.path).toBe("/x.md");
  });
});
