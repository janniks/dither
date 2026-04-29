import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("search", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-test-"));
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

  it("returns hits over a populated entries dir", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "auth.md"),
      "---\ntitle: Authentication flow\n---\n\nThis describes the OAuth2 authentication flow we use for login.",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { search } = await import("./search");
    const results = await search({ query: "authentication", mode: "lex" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("auth.md");
  });

  it("honors limit parameter", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(collectionDir, `note-${i}.md`),
        `---\ntitle: Note ${i}\n---\n\nThis note discusses authentication topic ${i}.\n`,
      );
    }

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { search } = await import("./search");
    const results = await search({ query: "authentication", mode: "lex", limit: 2 });

    expect(results).toHaveLength(2);
  });

  it("filters to a single collection when provided", async () => {
    const notes = join(home, "entries", "notes");
    const journal = join(home, "entries", "journal");
    mkdirSync(notes, { recursive: true });
    mkdirSync(journal, { recursive: true });
    writeFileSync(
      join(notes, "x.md"),
      "---\ntitle: x\n---\n\nThis text mentions widget specifically.\n",
    );
    writeFileSync(
      join(journal, "y.md"),
      "---\ntitle: y\n---\n\nThis text mentions widget specifically.\n",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { search } = await import("./search");
    const results = await search({
      query: "widget",
      mode: "lex",
      collection: "notes",
    });

    expect(results.length).toBeGreaterThan(0);
    for (const hit of results) {
      expect(hit.collection).toBe("notes");
    }
  });

  it("returns empty array when nothing matches", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "lone.md"),
      "---\ntitle: lone\n---\n\nThis only contains the word apple.\n",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { search } = await import("./search");
    const results = await search({ query: "zebrafish", mode: "lex" });

    expect(results).toEqual([]);
  });

  it("returns empty array when entries dir does not exist yet", async () => {
    const { search } = await import("./search");
    const results = await search({ query: "anything", mode: "lex" });

    expect(results).toEqual([]);
  });
});
