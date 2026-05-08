import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("partial reindex (Phase 4)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-partial-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(join(home, "entries"));
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("scoped updateIndex(collections) only re-scans the named collections", async () => {
    const collA = join(home, "entries", "alpha");
    const collB = join(home, "entries", "beta");
    mkdirSync(collA, { recursive: true });
    mkdirSync(collB, { recursive: true });
    writeFileSync(
      join(collA, "doc.md"),
      "---\ntitle: alpha-doc\n---\n\nfindme-alpha unique content.\n",
    );
    writeFileSync(
      join(collB, "doc.md"),
      "---\ntitle: beta-doc\n---\n\nfindme-beta unique content.\n",
    );

    const { updateIndex } = await import("./update-index");

    // Scoped update: only `alpha` is indexed.
    await updateIndex(["alpha"]);

    const { search } = await import("./search");
    const alphaHits = await search({ query: "findme-alpha", mode: "lex" });
    expect(alphaHits.length).toBeGreaterThan(0);

    const betaHits = await search({ query: "findme-beta", mode: "lex" });
    expect(betaHits).toEqual([]);

    // Now widen: full rescan picks up beta too.
    await updateIndex();
    const betaHitsAfter = await search({ query: "findme-beta", mode: "lex" });
    expect(betaHitsAfter.length).toBeGreaterThan(0);
  }, 30_000);

  it("plugin-run-style nested collection path narrows to top-level qmd collection", async () => {
    // Mirror the case plugin-run produces: a candidate with collection
    // "messages/inbox" must be narrowed to "messages" (the qmd collection
    // name = top-level library subdir) before calling updateIndex.
    const nested = join(home, "entries", "messages", "inbox");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "doc.md"), "---\ntitle: nested\n---\n\nNESTEDTOKEN unique body.\n");

    const candidates = [{ collection: "messages/inbox" }];
    const touchedCollections = Array.from(
      new Set(candidates.map((c) => c.collection.split("/")[0]!)),
    );
    expect(touchedCollections).toEqual(["messages"]);

    const { updateIndex } = await import("./update-index");
    const result = await updateIndex(touchedCollections);
    expect(result.collections).toBe(1);

    const { search } = await import("./search");
    const hits = await search({ query: "NESTEDTOKEN", mode: "lex" });
    expect(hits.length).toBeGreaterThan(0);
  }, 30_000);

  it("updateIndex with no arg is unchanged (full rescan)", async () => {
    const collA = join(home, "entries", "alpha");
    mkdirSync(collA, { recursive: true });
    writeFileSync(join(collA, "doc.md"), "---\ntitle: a\n---\n\nfullscan-token unique content.\n");

    const { updateIndex } = await import("./update-index");
    const result = await updateIndex();

    expect(result.collections).toBeGreaterThan(0);

    const { search } = await import("./search");
    const hits = await search({ query: "fullscan-token", mode: "lex" });
    expect(hits.length).toBeGreaterThan(0);
  }, 30_000);
});
