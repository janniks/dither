import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURE_PATH = resolve(__dirname, "..", "test", "fixtures", "import-folder");

describe("plugin host", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-plugin-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(join(home, "entries"));
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.DITHER_DIR;
    } else {
      process.env.DITHER_DIR = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("install + run a fixture plugin → entry appears in entries/<collection>/", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: FIXTURE_PATH });

    expect(existsSync(join(home, "plugins", "import-folder", "package.json"))).toBe(true);
    expect(existsSync(join(home, "plugins", "import-folder", "plugin.ts"))).toBe(true);
    expect(existsSync(join(home, "grants", "import-folder.json"))).toBe(true);

    const result = await runPlugin({ name: "import-folder" });
    expect(result.added.length).toBeGreaterThan(0);

    const importedDir = join(home, "entries", "imported");
    const files = readdirSync(importedDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    const content = readFileSync(join(importedDir, files[0]!), "utf-8");
    expect(content).toContain("Hello from fixture");
    expect(content).toContain('source: "import-folder"');
    expect(content).toContain('collection: "imported"');
  }, 60000);

  it("rejects a package.json without a 'dither' block at install time", async () => {
    const badPluginDir = mkdtempSync(join(tmpdir(), "dither-bad-plugin-"));
    writeFileSync(
      join(badPluginDir, "package.json"),
      JSON.stringify({ name: "bogus", version: "0.0.1" }),
    );
    writeFileSync(join(badPluginDir, "plugin.ts"), "// noop\n");

    const { installPlugin } = await import("./plugin-install");
    await expect(installPlugin({ source: badPluginDir })).rejects.toThrow(/missing 'dither' block/);

    rmSync(badPluginDir, { recursive: true, force: true });
  });

  it("rejects comma-containing permission paths before invoking Deno", async () => {
    const pluginDir = join(home, "plugins", "comma-path");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "comma-path", version: "0.0.1", dither: {} }),
    );
    writeFileSync(join(pluginDir, "plugin.ts"), "// noop\n");

    const grantedDir = join(home, "private,shared");
    mkdirSync(grantedDir);
    writeFileSync(join(grantedDir, "file.md"), "secret\n");
    mkdirSync(join(home, "grants"), { recursive: true });
    writeFileSync(
      join(home, "grants", "comma-path.json"),
      JSON.stringify({
        name: "comma-path",
        version: "0.0.1",
        files: { input: join(grantedDir, "file.md") },
      }),
    );

    const { runPlugin } = await import("./plugin-run");
    await expect(runPlugin({ name: "comma-path" })).rejects.toThrow(
      /Deno read permission entry contains an unsupported comma/,
    );
  });

  it("refuses to promote entries written to an ungranted collection", async () => {
    const escaperDir = mkdtempSync(join(tmpdir(), "dither-escape-plugin-"));
    writeFileSync(
      join(escaperDir, "package.json"),
      JSON.stringify({
        name: "escaper",
        version: "0.0.1",
        dither: { create: ["allowed"] },
      }),
    );
    writeFileSync(
      join(escaperDir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({
  collection: "forbidden",
  body: "trying to escape",
});
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: escaperDir });
    await expect(runPlugin({ name: "escaper" })).rejects.toThrow(
      /not granted write access to collection 'forbidden'/,
    );

    // Nothing should have been promoted to either collection.
    expect(existsSync(join(home, "entries", "forbidden"))).toBe(false);
    expect(
      existsSync(join(home, "entries", "allowed")) &&
        readdirSync(join(home, "entries", "allowed")).length > 0,
    ).toBe(false);

    rmSync(escaperDir, { recursive: true, force: true });
  }, 30000);

  it("nested grant: messages/** authorizes writes under messages/<sub>/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-nested-ok-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "nested-ok",
        version: "0.0.1",
        dither: { create: ["messages/**"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "messages/tom", body: "hi tom" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir });
    const result = await runPlugin({ name: "nested-ok" });
    expect(result.added.length).toBe(1);

    const tomDir = join(home, "entries", "messages", "tom");
    expect(existsSync(tomDir)).toBe(true);
    const files = readdirSync(tomDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);
    const content = readFileSync(join(tomDir, files[0]!), "utf-8");
    expect(content).toContain('collection: "messages/tom"');

    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("rejects path traversal in the frontmatter collection value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-traversal-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "traverser",
        version: "0.0.1",
        dither: { create: ["**"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "../../etc/passwd", body: "escape" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir });
    await expect(runPlugin({ name: "traverser" })).rejects.toThrow(/'\.\.'/);

    expect(existsSync(join(home, "entries", "..", "..", "etc"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it("sibling-subtree isolation: messages/tom/** does not authorize messages/jane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-sibling-subtree-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "tom-only",
        version: "0.0.1",
        dither: { create: ["messages/tom/**"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "messages/jane", body: "leak" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir });
    await expect(runPlugin({ name: "tom-only" })).rejects.toThrow(
      /not granted write access to collection 'messages\/jane'/,
    );

    expect(existsSync(join(home, "entries", "messages", "jane"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it("sibling-name leak prevented: messages/** does not authorize messages-archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-sibling-name-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "messages-only",
        version: "0.0.1",
        dither: { create: ["messages/**"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "messages-archive/x", body: "leak" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir });
    await expect(runPlugin({ name: "messages-only" })).rejects.toThrow(
      /not granted write access to collection 'messages-archive\/x'/,
    );

    expect(existsSync(join(home, "entries", "messages-archive"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it("nested grant: messages/** also authorizes the bare 'messages' collection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-nested-bare-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "nested-bare",
        version: "0.0.1",
        dither: { create: ["messages/**"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "messages", body: "bare parent" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir });
    const result = await runPlugin({ name: "nested-bare" });
    expect(result.added.length).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("install rejects an empty grant pattern", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-empty-grant-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "emptyish",
        version: "0.0.1",
        dither: { create: ["ok"] },
      }),
    );
    writeFileSync(join(dir, "plugin.ts"), `// noop\n`);

    const { installPlugin } = await import("./plugin-install");
    await expect(installPlugin({ source: dir, create: [""] })).rejects.toThrow(
      /grant pattern is empty/,
    );

    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it("install rejects a manifest grant pattern with '..'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-bad-manifest-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bad-manifest",
        version: "0.0.1",
        dither: { create: ["../*"] },
      }),
    );
    writeFileSync(join(dir, "plugin.ts"), `// noop\n`);

    const { installPlugin } = await import("./plugin-install");
    await expect(installPlugin({ source: dir })).rejects.toThrow(/'\.\.'/);

    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it("promote refuses to clobber a hand-authored entry at the same path", async () => {
    // Pre-existing user-authored file (no plugin source frontmatter).
    const collectionDir = join(home, "entries", "imported");
    mkdirSync(collectionDir, { recursive: true });
    const targetId = "fixture-clobber";
    writeFileSync(
      join(collectionDir, `${targetId}.md`),
      "---\ntitle: Hand-authored\n---\n\nDo not overwrite me.\n",
    );

    const dir = mkdtempSync(join(tmpdir(), "dither-clobber-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "clobberer",
        version: "0.0.1",
        dither: { create: ["imported"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({
  collection: "imported",
  frontmatter: { id: "${targetId}" },
  body: "trying to overwrite",
});
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir });
    await expect(runPlugin({ name: "clobberer" })).rejects.toThrow(/clobber/);

    // Original content is intact.
    const after = readFileSync(join(collectionDir, `${targetId}.md`), "utf-8");
    expect(after).toContain("Do not overwrite me.");

    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("external collection: promote lands at the external path, not the library", async () => {
    const ext = mkdtempSync(join(tmpdir(), "dither-ext-work-"));
    const { saveConfig, loadConfig } = await import("./config");
    const cfg = await loadConfig();
    await saveConfig({
      ...cfg!,
      collections: { external: [{ name: "work-notes", path: ext }] },
    });

    const dir = mkdtempSync(join(tmpdir(), "dither-extwriter-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "extwriter",
        version: "0.0.1",
        dither: { create: ["work-notes/**", "work-notes"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "work-notes", body: "in external" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");
    await installPlugin({ source: dir });
    const result = await runPlugin({ name: "extwriter" });
    expect(result.added.length).toBe(1);

    // File landed in the external mount, NOT under the library.
    const files = readdirSync(ext).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);
    expect(existsSync(join(home, "entries", "work-notes"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }, 60000);

  it("external collection: nested path resolves under the external root", async () => {
    const ext = mkdtempSync(join(tmpdir(), "dither-ext-nested-"));
    const { saveConfig, loadConfig } = await import("./config");
    await saveConfig({
      ...(await loadConfig())!,
      collections: { external: [{ name: "work-notes", path: ext }] },
    });

    const dir = mkdtempSync(join(tmpdir(), "dither-extnest-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "extnest",
        version: "0.0.1",
        dither: { create: ["work-notes/**"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "work-notes/sub/2026", body: "deep" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");
    await installPlugin({ source: dir });
    const result = await runPlugin({ name: "extnest" });
    expect(result.added.length).toBe(1);

    const target = join(ext, "sub", "2026");
    expect(existsSync(target)).toBe(true);
    const files = readdirSync(target).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);

    rmSync(dir, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }, 60000);

  it("unregistered collection auto-creates under the library (regression guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-autocreate-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "autocreator",
        version: "0.0.1",
        dither: { create: ["fresh"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "fresh", body: "library auto" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");
    await installPlugin({ source: dir });
    const result = await runPlugin({ name: "autocreator" });
    expect(result.added.length).toBe(1);

    const freshDir = join(home, "entries", "fresh");
    expect(existsSync(freshDir)).toBe(true);
    expect(readdirSync(freshDir).filter((f) => f.endsWith(".md")).length).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("external collection: promote errors when the external path is missing", async () => {
    const ext = mkdtempSync(join(tmpdir(), "dither-ext-missing-"));
    const { saveConfig, loadConfig } = await import("./config");
    await saveConfig({
      ...(await loadConfig())!,
      collections: { external: [{ name: "vanished", path: ext }] },
    });
    rmSync(ext, { recursive: true, force: true });

    const dir = mkdtempSync(join(tmpdir(), "dither-extmissing-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "missingwriter",
        version: "0.0.1",
        dither: { create: ["vanished/**", "vanished"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "vanished", body: "ghost" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");
    await installPlugin({ source: dir });
    await expect(runPlugin({ name: "missingwriter" })).rejects.toThrow(/path is missing/);

    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("SDK writeEntry rejects '..' in filename and frontmatter.id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-sdk-traversal-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "sdk-traverser",
        version: "0.0.1",
        dither: { create: ["safe"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({
  collection: "safe",
  filename: "../escape.md",
  body: "should be rejected",
});
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir });
    // Plugin throws inside Deno → host wraps it as a non-zero exit.
    await expect(runPlugin({ name: "sdk-traverser" })).rejects.toThrow(/exited with code/);

    // Nothing escaped runs/ or plugins/ — the run dir cleanup also covers this.
    expect(existsSync(join(home, "escape.md"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it("run dir is cleaned up even when promote fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-cleanup-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "fail-promote",
        version: "0.0.1",
        dither: { create: ["allowed"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "forbidden", body: "this will fail to promote" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir });
    await expect(runPlugin({ name: "fail-promote" })).rejects.toThrow(/not granted/);

    // No leftover run dir — the try/finally guarantees cleanup even on throw.
    const runsDir = join(home, "runs");
    if (existsSync(runsDir)) {
      const remaining = readdirSync(runsDir);
      expect(remaining).toEqual([]);
    }

    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it("install grant can widen past the manifest (manifest is default, not ceiling)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-widen-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "widener",
        version: "0.0.1",
        // Manifest declares one collection; user grants a different, broader one.
        dither: { create: ["messages"] },
      }),
    );
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";
await writeEntry({ collection: "notes/personal", body: "ok" });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: dir, create: ["notes/**"] });
    const result = await runPlugin({ name: "widener" });
    expect(result.added.length).toBe(1);

    const personalDir = join(home, "entries", "notes", "personal");
    expect(existsSync(personalDir)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("journals progress() messages as `progress` events", async () => {
    const progDir = mkdtempSync(join(tmpdir(), "dither-progress-plugin-"));
    writeFileSync(
      join(progDir, "package.json"),
      JSON.stringify({
        name: "progresser",
        version: "0.0.1",
        dither: { create: ["notes"] },
      }),
    );
    writeFileSync(
      join(progDir, "plugin.ts"),
      `import { progress, writeEntry } from "@dither/plugin";
progress({ message: "starting" });
progress({ message: "halfway", done: 1, total: 2 });
await writeEntry({ collection: "notes", body: "ok" });
progress({ message: "done", done: 2, total: 2 });
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");
    const { readRun } = await import("./run-log");

    await installPlugin({ source: progDir });
    const result = await runPlugin({ name: "progresser" });
    expect(result.added.length).toBe(1);

    const events = await readRun(result.runId);
    const progress = events
      .filter((e) => e.kind === "progress")
      .map((e) => ({ message: e.message, done: e.done, total: e.total }));
    expect(progress).toEqual([
      { message: "starting", done: undefined, total: undefined },
      { message: "halfway", done: 1, total: 2 },
      { message: "done", done: 2, total: 2 },
    ]);

    rmSync(progDir, { recursive: true, force: true });
  }, 60000);

  it("persists plugin state across runs via readState/writeState", async () => {
    const counterDir = mkdtempSync(join(tmpdir(), "dither-counter-plugin-"));
    mkdirSync(counterDir, { recursive: true });
    writeFileSync(
      join(counterDir, "package.json"),
      JSON.stringify({
        name: "counter",
        version: "0.0.1",
        dither: { create: ["counts"] },
      }),
    );
    writeFileSync(
      join(counterDir, "plugin.ts"),
      `import { readState, writeState, writeEntry } from "@dither/plugin";

interface State { runs: number }

const prev = await readState<State>({ runs: 0 });
const next: State = { runs: prev.runs + 1 };
await writeState(next);

await writeEntry({
  collection: "counts",
  filename: "run-" + next.runs + ".md",
  body: "Run number " + next.runs,
});
`,
    );

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: counterDir });
    await runPlugin({ name: "counter" });
    await runPlugin({ name: "counter" });
    await runPlugin({ name: "counter" });

    const stateRaw = readFileSync(join(home, "plugins", "counter", "state", "state.json"), "utf-8");
    expect(JSON.parse(stateRaw)).toEqual({ runs: 3 });

    const countsDir = join(home, "entries", "counts");
    expect(existsSync(join(countsDir, "run-1.md"))).toBe(true);
    expect(existsSync(join(countsDir, "run-3.md"))).toBe(true);

    rmSync(counterDir, { recursive: true, force: true });
  }, 60000);

  // The per-plugin lock used to live in runPlugin; it now lives in
  // fireWithSuppress (daemon-side). runPlugin itself no longer single-
  // arbiters — it's a pure orchestrator. The four daemon fire sources
  // (Scheduler, Watcher, Refirer, Kicker) all funnel through the one
  // lock-acquiring entry point, so the "one wins, one rejects" property
  // is now a property of fireWithSuppress, not runPlugin.

  it("captures a final unterminated stderr reschedule before run completion", async () => {
    vi.resetModules();
    const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
    child.stderr = new PassThrough();
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("./deno-bootstrap", () => ({ ensureDeno: async () => "/fake/deno" }));

    const name = "late-rescheduler";
    const pluginDir = join(home, "plugins", name);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name, version: "0.0.1", dither: {} }),
    );
    writeFileSync(join(pluginDir, "plugin.ts"), "// mocked\n");
    mkdirSync(join(home, "grants"), { recursive: true });
    writeFileSync(join(home, "grants", `${name}.json`), JSON.stringify({ name }));

    try {
      const { runPlugin } = await import("./plugin-run");
      const { readRefire } = await import("./refire");
      const run = runPlugin({ name });

      process.nextTick(() => {
        child.emit("exit", 0);
        setTimeout(() => {
          child.stderr.once("end", () => child.emit("close", 0));
          child.stderr.end(JSON.stringify({ _dither: "reschedule", afterMs: 1000 }));
        }, 25);
      });

      await run;
      const row = await readRefire(name);
      expect(row).not.toBeNull();
      expect(row?.retryCount).toBe(0);
    } finally {
      vi.doUnmock("node:child_process");
      vi.doUnmock("./deno-bootstrap");
      vi.resetModules();
    }
  });

  it("runPlugin produces a run-history journal with manifest, events, and result", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");
    const { listRuns, readRun } = await import("./run-log");

    await installPlugin({ source: FIXTURE_PATH });
    const result = await runPlugin({ name: "import-folder" });

    const runs = await listRuns();
    const ours = runs.find((r) => r.runId === result.runId);
    expect(ours).toBeDefined();
    expect(ours!.status).toBe("ok");
    expect(ours!.plugin).toBe("import-folder");
    expect(ours!.addedCount).toBeGreaterThan(0);

    const events = await readRun(result.runId);
    const added = events.filter((e) => e.kind === "added");
    expect(added.length).toBeGreaterThan(0);
  }, 60000);

  it("releases the lock after a failed run", async () => {
    const failDir = mkdtempSync(join(tmpdir(), "dither-fail-lock-"));
    mkdirSync(failDir, { recursive: true });
    writeFileSync(
      join(failDir, "package.json"),
      JSON.stringify({
        name: "lock-fail",
        version: "0.0.1",
        dither: { create: ["x"] },
      }),
    );
    writeFileSync(join(failDir, "plugin.ts"), `throw new Error("boom");\n`);

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: failDir });
    await expect(runPlugin({ name: "lock-fail" })).rejects.toThrow();
    expect(existsSync(join(home, "locks", "lock-fail.lock"))).toBe(false);

    rmSync(failDir, { recursive: true, force: true });
  }, 60000);
});
