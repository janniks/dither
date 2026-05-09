import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURE_PATH = resolve(__dirname, "..", "test", "fixtures", "import-folder");

describe("library resolver (Phase 2)", () => {
  let home: string;
  let library: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-libresolver-test-"));
    library = mkdtempSync(join(tmpdir(), "dither-libresolver-lib-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(library);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(library, { recursive: true, force: true });
  });

  it("plugin promote lands in the configured library, not in dither home", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({ source: FIXTURE_PATH });
    const result = await runPlugin({ name: "import-folder" });
    expect(result.promoted.length).toBeGreaterThan(0);

    // Files land under the external library, not dither home.
    const libraryCollectionDir = join(library, "imported");
    expect(existsSync(libraryCollectionDir)).toBe(true);
    expect(
      readdirSync(libraryCollectionDir).filter((f) => f.endsWith(".md")).length,
    ).toBeGreaterThan(0);

    // Dither home does NOT carry an `entries/` directory anymore.
    expect(existsSync(join(home, "entries"))).toBe(false);

    // Dither home still owns its own bookkeeping (plugins, grants, runs).
    expect(existsSync(join(home, "plugins", "import-folder"))).toBe(true);
    expect(existsSync(join(home, "grants", "import-folder.json"))).toBe(true);

    // qmd index lives in dither home, not in the library.
    expect(existsSync(join(home, "qmd-index.sqlite"))).toBe(true);
    expect(existsSync(join(library, "qmd-index.sqlite"))).toBe(false);
  }, 60000);

  it("search and get find content in the external library", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");
    const { search } = await import("./search");
    const { get } = await import("./get");

    await installPlugin({ source: FIXTURE_PATH });
    await runPlugin({ name: "import-folder" });

    const hits = await search({ query: "fixture", mode: "lex" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toContain("imported/");

    const content = await get({ ref: hits[0]!.path });
    expect(content).toContain("@dither/plugin SDK");
  }, 60000);
});
