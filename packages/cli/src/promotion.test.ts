import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunHandle } from "./run-log";

interface JournalEvent {
  kind: string;
  [key: string]: unknown;
}

function fakeJournal(): { handle: RunHandle; events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  const handle: RunHandle = {
    runId: "test-run",
    dir: "/tmp/test-run",
    async append(event) {
      events.push(event as JournalEvent);
    },
    async close() {},
    async setChildPid() {},
  };
  return { handle, events };
}

function entry(plugin: string, collection: string, body = "hello"): string {
  return `---\nsource: ${plugin}\ncollection: ${collection}\n---\n\n${body}\n`;
}

describe("promote", () => {
  let home: string;
  let prev: string | undefined;
  let runDir: string;
  let libraryPath: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-promote-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    runDir = join(home, "runs", "test-run");
    mkdirSync(runDir, { recursive: true });
    libraryPath = join(home, "library");
    mkdirSync(libraryPath, { recursive: true });
    // Promote's qmd-index update path calls openStore which needs a
    // saved config. The deferred-reindex path doesn't, but easier to
    // satisfy assertInitialized once in setup.
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(libraryPath);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  function cfg() {
    return {
      library: { path: libraryPath },
      collections: { external: [] },
    } as unknown as import("./config").DitherConfig;
  }

  it("promotes valid frontmatter into the library", async () => {
    writeFileSync(join(runDir, "a.md"), entry("p", "notes"));
    const { promote } = await import("./promotion");
    const j = fakeJournal();
    const out = await promote({
      runDir,
      plugin: "p",
      config: cfg(),
      grants: ["notes"],
      journal: j.handle,
    });
    expect(out.added).toHaveLength(1);
    expect(existsSync(join(libraryPath, "notes", "a.md"))).toBe(true);
    expect(j.events.some((e) => e.kind === "added")).toBe(true);
  });

  it("rejects when frontmatter source does not match the plugin", async () => {
    writeFileSync(join(runDir, "a.md"), entry("other-plugin", "notes"));
    const { promote } = await import("./promotion");
    const j = fakeJournal();
    await expect(
      promote({
        runDir,
        plugin: "p",
        config: cfg(),
        grants: ["notes"],
        journal: j.handle,
      }),
    ).rejects.toThrow(/declares source=other-plugin/);
  });

  it("rejects when the collection is not granted", async () => {
    writeFileSync(join(runDir, "a.md"), entry("p", "secrets"));
    const { promote } = await import("./promotion");
    const j = fakeJournal();
    await expect(
      promote({
        runDir,
        plugin: "p",
        config: cfg(),
        grants: ["notes"],
        journal: j.handle,
      }),
    ).rejects.toThrow(/not granted write access/);
  });

  it("rejects when 'collection' frontmatter is missing", async () => {
    writeFileSync(join(runDir, "a.md"), `---\nsource: p\n---\nhi\n`);
    const { promote } = await import("./promotion");
    const j = fakeJournal();
    await expect(
      promote({
        runDir,
        plugin: "p",
        config: cfg(),
        grants: ["notes"],
        journal: j.handle,
      }),
    ).rejects.toThrow(/missing 'collection' frontmatter/);
  });

  it("skips (not fails) another plugin's entry without an edit grant", async () => {
    mkdirSync(join(libraryPath, "notes"), { recursive: true });
    writeFileSync(join(libraryPath, "notes", "a.md"), entry("rival", "notes", "older"));
    writeFileSync(join(runDir, "a.md"), entry("p", "notes"));
    writeFileSync(join(runDir, "b.md"), entry("p", "notes", "fresh"));

    const { promote } = await import("./promotion");
    const j = fakeJournal();
    const out = await promote({
      runDir,
      plugin: "p",
      config: cfg(),
      grants: ["notes"],
      journal: j.handle,
    });
    // a.md skipped, b.md promoted — the run stays ok.
    expect(out.skipped).toHaveLength(1);
    expect(out.added).toHaveLength(1);
    expect(readFileSync(join(libraryPath, "notes", "a.md"), "utf-8")).toContain("older");
    expect(existsSync(join(libraryPath, "notes", "b.md"))).toBe(true);
    const skip = j.events.find((e) => e.kind === "skipped");
    expect(skip?.path).toContain("a.md");
    expect(String(skip?.reason)).toMatch(/edit grant/);
  });

  it("overwrites another plugin's entry when an edit grant covers the collection", async () => {
    mkdirSync(join(libraryPath, "notes"), { recursive: true });
    writeFileSync(join(libraryPath, "notes", "a.md"), entry("rival", "notes", "older"));
    writeFileSync(join(runDir, "a.md"), entry("p", "notes", "enriched"));

    const { promote } = await import("./promotion");
    const j = fakeJournal();
    const out = await promote({
      runDir,
      plugin: "p",
      config: cfg(),
      grants: ["notes"],
      edits: ["notes"],
      journal: j.handle,
    });
    expect(out.added).toHaveLength(1);
    expect(out.skipped).toHaveLength(0);
    expect(readFileSync(join(libraryPath, "notes", "a.md"), "utf-8")).toContain("enriched");
  });

  it("same-source overwrite needs no edit grant", async () => {
    mkdirSync(join(libraryPath, "notes"), { recursive: true });
    writeFileSync(join(libraryPath, "notes", "a.md"), entry("p", "notes", "v1"));
    writeFileSync(join(runDir, "a.md"), entry("p", "notes", "v2"));

    const { promote } = await import("./promotion");
    const j = fakeJournal();
    const out = await promote({
      runDir,
      plugin: "p",
      config: cfg(),
      grants: ["notes"],
      journal: j.handle,
    });
    expect(out.added).toHaveLength(1);
    expect(out.skipped).toHaveLength(0);
    expect(readFileSync(join(libraryPath, "notes", "a.md"), "utf-8")).toContain("v2");
  });

  it("when qmd-index lock is held, writes needs-reindex and journals reindex-deferred", async () => {
    writeFileSync(join(runDir, "a.md"), entry("p", "notes"));
    // Pre-hold the qmd-index lock with this test process's pid.
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", "qmd-index.lock"), String(process.pid));

    const { promote } = await import("./promotion");
    const j = fakeJournal();
    const out = await promote({
      runDir,
      plugin: "p",
      config: cfg(),
      grants: ["notes"],
      journal: j.handle,
    });

    expect(out.added).toHaveLength(1);
    expect(out.reindexDeferred).toBe(true);
    expect(existsSync(join(home, "markers", "needs-reindex"))).toBe(true);
    expect(j.events.some((e) => e.kind === "reindex-deferred")).toBe(true);
  });

  it("returns no-op result when the run dir contains no .md files", async () => {
    writeFileSync(join(runDir, "junk.txt"), "ignored");
    const { promote } = await import("./promotion");
    const j = fakeJournal();
    const out = await promote({
      runDir,
      plugin: "p",
      config: cfg(),
      grants: ["notes"],
      journal: j.handle,
    });
    expect(out.added).toEqual([]);
    expect(out.reindexDeferred).toBe(false);
  });
});
