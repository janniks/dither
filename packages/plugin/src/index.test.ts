import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("plugin SDK state I/O", () => {
  let dir: string;
  let path: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dither-plugin-state-"));
    path = join(dir, "state.json");
    prev = process.env.DITHER_STATE_FILE;
    process.env.DITHER_STATE_FILE = path;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_STATE_FILE;
    else process.env.DITHER_STATE_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("readState returns the initial value when no file exists", async () => {
    const sdk = await import("./index");
    const initial = { cursor: "init" };
    expect(await sdk.readState(initial)).toEqual(initial);
  });

  it("writeState produces the final file and leaves no tmp siblings", async () => {
    const sdk = await import("./index");
    await sdk.writeState({ cursor: "abc" });

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ cursor: "abc" });

    const stragglers = readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });

  it("writeState round-trips through readState", async () => {
    const sdk = await import("./index");
    await sdk.writeState({ cursor: "xyz", count: 3 });
    expect(await sdk.readState({ cursor: "", count: 0 })).toEqual({
      cursor: "xyz",
      count: 3,
    });
  });
});

describe("plugin SDK writeEntry frontmatter", () => {
  let runDir: string;
  let prevRun: string | undefined;
  let prevName: string | undefined;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "dither-plugin-entry-"));
    prevRun = process.env.DITHER_RUN_DIR;
    prevName = process.env.DITHER_PLUGIN_NAME;
    process.env.DITHER_RUN_DIR = runDir;
    process.env.DITHER_PLUGIN_NAME = "test-plugin";
  });

  afterEach(() => {
    if (prevRun === undefined) delete process.env.DITHER_RUN_DIR;
    else process.env.DITHER_RUN_DIR = prevRun;
    if (prevName === undefined) delete process.env.DITHER_PLUGIN_NAME;
    else process.env.DITHER_PLUGIN_NAME = prevName;
    rmSync(runDir, { recursive: true, force: true });
  });

  it("drops undefined frontmatter keys instead of writing 'undefined'", async () => {
    const sdk = await import("./index");
    const out = await sdk.writeEntry({
      collection: "notes",
      body: "hi",
      frontmatter: { title: "ok", url: undefined, count: 3 },
    });
    const content = readFileSync(out, "utf-8");
    expect(content).toContain('title: "ok"');
    expect(content).toContain("count: 3");
    expect(content).not.toContain("undefined");
    expect(content).not.toContain("url:");
  });

  it("rejects bigint values with a clear error", async () => {
    const sdk = await import("./index");
    await expect(
      sdk.writeEntry({
        collection: "notes",
        body: "hi",
        // Cast through unknown so the test still compiles after the type
        // constraint — we're exercising the runtime guard.
        frontmatter: { big: 1n as unknown as string },
      }),
    ).rejects.toThrow(/bigint is not supported/);
  });

  it("rejects functions and symbols with a clear error", async () => {
    const sdk = await import("./index");
    await expect(
      sdk.writeEntry({
        collection: "notes",
        body: "hi",
        frontmatter: { fn: (() => 1) as unknown as string },
      }),
    ).rejects.toThrow(/function is not supported/);
  });

  it("emits null literal for explicit nulls", async () => {
    const sdk = await import("./index");
    const out = await sdk.writeEntry({
      collection: "notes",
      body: "hi",
      frontmatter: { tag: null },
    });
    expect(readFileSync(out, "utf-8")).toContain("tag: null");
  });
});
