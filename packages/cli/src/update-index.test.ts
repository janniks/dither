import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("updateIndex", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-update-test-"));
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

  it("returns zero counts when there are no collections to index", async () => {
    const { updateIndex } = await import("./update-index");
    const result = await updateIndex();
    expect(result.collections).toBe(0);
    expect(result.indexed).toBe(0);
  });

  it("after updateIndex, search finds entries written before the update call", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "doc.md"),
      "---\ntitle: Doc\n---\n\nThe quick brown fox jumps over the lazy dog.",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { search } = await import("./search");
    const hits = await search({ query: "quick", mode: "lex" });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("search WITHOUT a prior updateIndex call returns no hits for newly-written files", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "fresh.md"),
      "---\ntitle: Fresh\n---\n\nThis content is unindexed and should not be findable.",
    );

    const { search } = await import("./search");
    const hits = await search({ query: "unindexed", mode: "lex" });
    expect(hits).toEqual([]);
  });
});
