import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Watcher", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-watcher-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
    mkdirSync(join(home, "entries", "messages"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("debounces N rapid file changes into one fire", async () => {
    const { Watcher } = await import("./watcher");
    const fires: Array<{ name: string; targets: string[] }> = [];
    const watcher = new Watcher((name, targets) => {
      fires.push({ name, targets });
    });

    watcher.set([{ name: "tagger", collections: ["messages"] }]);
    await new Promise((r) => setTimeout(r, 200)); // chokidar warmup

    const path1 = join(home, "entries", "messages", "a.md");
    const path2 = join(home, "entries", "messages", "b.md");
    writeFileSync(path1, "one");
    writeFileSync(path2, "two");

    // Wait past debounce.
    await new Promise((r) => setTimeout(r, 6000));
    watcher.stop();

    expect(fires.length).toBe(1);
    expect(fires[0]?.name).toBe("tagger");
    expect(fires[0]?.targets.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("respects the glob filter", async () => {
    const { Watcher } = await import("./watcher");
    const fires: Array<{ name: string; targets: string[] }> = [];
    const watcher = new Watcher((name, targets) => {
      fires.push({ name, targets });
    });

    watcher.set([{ name: "md-only", collections: ["messages"], glob: "**/*.md" }]);
    await new Promise((r) => setTimeout(r, 200));

    writeFileSync(join(home, "entries", "messages", "ignored.txt"), "x");
    writeFileSync(join(home, "entries", "messages", "kept.md"), "y");

    await new Promise((r) => setTimeout(r, 6000));
    watcher.stop();

    expect(fires).toHaveLength(1);
    expect(fires[0]?.targets.some((t) => t.endsWith("kept.md"))).toBe(true);
    expect(fires[0]?.targets.some((t) => t.endsWith("ignored.txt"))).toBe(false);
  }, 15_000);

  it("suppressOnce drops the matching event", async () => {
    const { Watcher } = await import("./watcher");
    const fires: Array<{ name: string; targets: string[] }> = [];
    const watcher = new Watcher((name, targets) => {
      fires.push({ name, targets });
    });

    watcher.set([{ name: "self", collections: ["messages"] }]);
    await new Promise((r) => setTimeout(r, 200));

    const path = join(home, "entries", "messages", "self.md");
    watcher.suppressOnce(path);
    writeFileSync(path, "self-write");

    await new Promise((r) => setTimeout(r, 6000));
    watcher.stop();

    expect(fires).toHaveLength(0);
  }, 15_000);
});
