import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURE_PATH = resolve(__dirname, "..", "test", "fixtures", "import-folder");

describe("pipeline (install → run → search → get)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-pipeline-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(join(home, "entries"));
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.DITHER_HOME;
    } else {
      process.env.DITHER_HOME = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("entries written by a plugin are searchable and retrievable without manual reindex", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");
    const { search } = await import("./search");
    const { get } = await import("./get");

    await installPlugin({ source: FIXTURE_PATH });
    const runResult = await runPlugin({ name: "import-folder" });
    expect(runResult.promoted.length).toBeGreaterThan(0);

    // No manual updateIndex() — runPlugin must hook it.
    const hits = await search({ query: "fixture", mode: "lex" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toContain("imported/");
    expect(hits[0]?.collection).toBe("imported");

    const content = await get({ ref: hits[0]!.path });
    expect(content).toContain("@dither/plugin SDK");
  }, 60000);
});
