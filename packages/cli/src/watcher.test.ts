import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Watcher", () => {
  let home: string;
  let prevHome: string | undefined;

  let libRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-watcher-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    libRoot = join(home, "entries");
    mkdirSync(join(libRoot, "messages"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("debounces N rapid file changes into one fire and writes inbox rows", async () => {
    const { Watcher } = await import("./watcher");
    const fires: string[] = [];
    const watcher = new Watcher((name) => {
      fires.push(name);
    }, { debounceMs: 200, debounceCapMs: 1_000 });

    watcher.set(libRoot, [{ name: "tagger", collections: ["messages"] }]);
    await new Promise((r) => setTimeout(r, 200)); // chokidar warmup

    writeFileSync(join(libRoot, "messages", "a.md"), "one");
    writeFileSync(join(libRoot, "messages", "b.md"), "two");

    await new Promise((r) => setTimeout(r, 1_500));
    watcher.stop();

    expect(fires).toEqual(["tagger"]);
    const inbox = readFileSync(join(home, "inboxes", "tagger.ndjson"), "utf-8");
    const rows = inbox.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const paths = rows.map((r) => r.path);
    expect(paths.some((p: string) => p.endsWith("a.md"))).toBe(true);
    expect(paths.some((p: string) => p.endsWith("b.md"))).toBe(true);
    for (const r of rows) {
      expect(typeof r.mtime).toBe("string");
      expect(r.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  }, 10_000);

  it("respects the glob filter", async () => {
    const { Watcher } = await import("./watcher");
    const fires: string[] = [];
    const watcher = new Watcher((name) => {
      fires.push(name);
    }, { debounceMs: 200, debounceCapMs: 1_000 });

    watcher.set(libRoot, [{ name: "md-only", collections: ["messages"], glob: "**/*.md" }]);
    await new Promise((r) => setTimeout(r, 200));

    writeFileSync(join(libRoot, "messages", "ignored.txt"), "x");
    writeFileSync(join(libRoot, "messages", "kept.md"), "y");

    await new Promise((r) => setTimeout(r, 1_500));
    watcher.stop();

    expect(fires).toEqual(["md-only"]);
    const inbox = readFileSync(join(home, "inboxes", "md-only.ndjson"), "utf-8");
    const paths = inbox.split("\n").filter(Boolean).map((l) => JSON.parse(l).path as string);
    expect(paths.some((p) => p.endsWith("kept.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("ignored.txt"))).toBe(false);
  }, 10_000);

  it("suppressOnce drops the matching event", async () => {
    const { Watcher } = await import("./watcher");
    const fires: string[] = [];
    const watcher = new Watcher((name) => {
      fires.push(name);
    }, { debounceMs: 200, debounceCapMs: 1_000 });

    watcher.set(libRoot, [{ name: "self", collections: ["messages"] }]);
    await new Promise((r) => setTimeout(r, 200));

    const path = join(libRoot, "messages", "self.md");
    watcher.suppressOnce(path);
    writeFileSync(path, "self-write");

    await new Promise((r) => setTimeout(r, 1_500));
    watcher.stop();

    expect(fires).toEqual([]);
    expect(existsSync(join(home, "inboxes", "self.ndjson"))).toBe(false);
  }, 10_000);
});
