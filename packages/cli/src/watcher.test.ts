import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
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
    watcher.start();
    await new Promise((r) => setTimeout(r, 200)); // watch warmup

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
    watcher.start();
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

  it("recover enqueues files changed while stopped, then advances the watermark", async () => {
    const { Watcher } = await import("./watcher");
    const { claimInbox } = await import("./inbox");
    const { readWatermark, watchKey } = await import("./watch-state");

    const watcher = new Watcher(() => {});
    // A file that landed while the daemon was down — written before set() so the
    // live watcher never sees it (fs.watch only emits changes after it starts);
    // only the recover scan can pick it up.
    writeFileSync(join(libRoot, "messages", "down.md"), "missed");
    watcher.set(libRoot, [{ name: "tagger", collections: ["messages"] }]);

    const fired: string[] = [];
    await watcher.recover((name) => {
      fired.push(name);
    });
    watcher.stop();

    expect(fired).toEqual(["tagger"]);
    const claimed = await claimInbox("tagger");
    expect(claimed.map((t) => t.path).some((p) => p.endsWith("down.md"))).toBe(true);

    const mark = await readWatermark(watchKey("tagger", "messages"));
    expect(mark).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("recover does not re-enqueue a file at or below the watermark", async () => {
    const { Watcher } = await import("./watcher");
    const { claimInbox } = await import("./inbox");

    const watcher = new Watcher(() => {});
    // Pre-existing file (written before set()) so only recover, not the live
    // watcher, accounts for it.
    writeFileSync(join(libRoot, "messages", "old.md"), "v1");
    watcher.set(libRoot, [{ name: "tagger", collections: ["messages"] }]);

    // First recover enqueues + sets watermark to old.md's mtime.
    await watcher.recover(() => {});
    await claimInbox("tagger"); // drain it

    // Second recover with no new change: watermark already covers old.md.
    const fired: string[] = [];
    await watcher.recover((name) => {
      fired.push(name);
    });
    watcher.stop();

    expect(fired).toEqual([]);
    const claimed = await claimInbox("tagger");
    expect(claimed).toEqual([]);
  });

  it("recover honors the glob filter", async () => {
    const { Watcher } = await import("./watcher");
    const { claimInbox } = await import("./inbox");

    const watcher = new Watcher(() => {});
    // Pre-existing files (before set()) so only recover's walk accounts for them.
    writeFileSync(join(libRoot, "messages", "kept.md"), "y");
    // .txt isn't an .md file — walkMd never sees it.
    writeFileSync(join(libRoot, "messages", "ignored.txt"), "x");
    watcher.set(libRoot, [{ name: "md-only", collections: ["messages"], glob: "**/*.md" }]);

    await watcher.recover(() => {});
    watcher.stop();

    const claimed = await claimInbox("md-only");
    const paths = claimed.map((t) => t.path);
    expect(paths.some((p) => p.endsWith("kept.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("ignored.txt"))).toBe(false);
  });

  it("suppressOnce drops the matching event", async () => {
    const { Watcher } = await import("./watcher");
    const fires: string[] = [];
    const watcher = new Watcher((name) => {
      fires.push(name);
    }, { debounceMs: 200, debounceCapMs: 1_000 });

    watcher.set(libRoot, [{ name: "self", collections: ["messages"] }]);
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));

    const path = join(libRoot, "messages", "self.md");
    watcher.suppressOnce(path);
    writeFileSync(path, "self-write");

    await new Promise((r) => setTimeout(r, 1_500));
    watcher.stop();

    expect(fires).toEqual([]);
    expect(existsSync(join(home, "inboxes", "self.ndjson"))).toBe(false);
  }, 10_000);

  // Regression for the chokidar fd leak: a watched collection with N files must
  // cost O(1) fds (one OS recursive/dir handle), not O(N) (one fs.watch per
  // file). The old chokidar path opened ~N fds here and exhausted the process.
  it("watches a large flat collection with O(1) fds, not O(files)", async () => {
    const { Watcher } = await import("./watcher");
    const dir = join(libRoot, "big");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 1_000; i++) writeFileSync(join(dir, `${i}.md`), "x");

    const fds = () => readdirSync("/dev/fd").length;
    const before = fds();
    const watcher = new Watcher(() => {}, { debounceMs: 50, debounceCapMs: 200 });
    watcher.set(libRoot, [{ name: "big", collections: ["big"] }]);
    watcher.start();
    await new Promise((r) => setTimeout(r, 300));
    const delta = fds() - before;
    watcher.stop();

    expect(delta).toBeLessThan(50); // one handle, not ~1000
  }, 15_000);
});
