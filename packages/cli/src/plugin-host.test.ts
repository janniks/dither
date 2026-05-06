import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-plugin-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.DITHER_HOME;
    } else {
      process.env.DITHER_HOME = prevHome;
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
    expect(result.promoted.length).toBeGreaterThan(0);

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

  it("refuses to promote entries written to an ungranted collection", async () => {
    const escaperDir = mkdtempSync(join(tmpdir(), "dither-escape-plugin-"));
    writeFileSync(
      join(escaperDir, "package.json"),
      JSON.stringify({
        name: "escaper",
        version: "0.0.1",
        dither: { collections: ["allowed"] },
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
        dither: { collections: ["messages/**"] },
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
    expect(result.promoted.length).toBe(1);

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
        dither: { collections: ["**"] },
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
        dither: { collections: ["messages/tom/**"] },
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
        dither: { collections: ["messages/**"] },
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

  it("install grant can widen past the manifest (manifest is default, not ceiling)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-widen-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "widener",
        version: "0.0.1",
        // Manifest declares one collection; user grants a different, broader one.
        dither: { collections: ["messages"] },
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

    await installPlugin({ source: dir, collections: ["notes/**"] });
    const result = await runPlugin({ name: "widener" });
    expect(result.promoted.length).toBe(1);

    const personalDir = join(home, "entries", "notes", "personal");
    expect(existsSync(personalDir)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("forwards progress() messages through onProgress and hides them from stderr", async () => {
    const progDir = mkdtempSync(join(tmpdir(), "dither-progress-plugin-"));
    writeFileSync(
      join(progDir, "package.json"),
      JSON.stringify({
        name: "progresser",
        version: "0.0.1",
        dither: { collections: ["notes"] },
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

    await installPlugin({ source: progDir });
    const seen: { message: string; done?: number; total?: number }[] = [];
    const result = await runPlugin({
      name: "progresser",
      onProgress: (m) => seen.push(m),
    });

    expect(result.promoted.length).toBe(1);
    expect(seen).toEqual([
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
        dither: { collections: ["counts"] },
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
});
