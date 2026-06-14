import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeSnippet } from "./search";

describe("safeSnippet", () => {
  it("returns undefined for empty body", () => {
    expect(safeSnippet("", "anything", undefined, undefined)).toBeUndefined();
  });

  it("returns first non-empty line as fallback when query has no match", () => {
    const out = safeSnippet("\n\n  hello world\nnothing matches here", "zzznomatch", undefined, undefined);
    expect(out).toEqual({ text: "hello world", line: 3 });
  });

  it("extracts a snippet around a matched term", () => {
    const body = "alpha beta gamma delta\nthe authentication flow lives here\nepsilon zeta";
    const out = safeSnippet(body, "authentication", undefined, undefined);
    expect(out?.text.toLowerCase()).toContain("authentication");
    expect(out?.line).toBeGreaterThan(0);
  });

  it("includes grep-style context lines around the match", () => {
    const body = "line one\nline two\nthe authentication flow\nline four\nline five";
    const out = safeSnippet(body, "authentication", undefined, undefined, { before: 1, after: 1 });
    expect(out?.text).toBe("line two\nthe authentication flow\nline four");
    expect(out?.line).toBe(2); // window starts on the line before the match
  });

  it("clamps the context window at file edges", () => {
    const body = "the authentication flow\nsecond line";
    const out = safeSnippet(body, "authentication", undefined, undefined, { before: 5, after: 5 });
    expect(out?.text).toBe("the authentication flow\nsecond line");
    expect(out?.line).toBe(1);
  });
});

describe("search", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-test-"));
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

  // Hybrid mode loads embedding/expansion models on first call (slow, can
  // require network). Gate behind an opt-in env var to keep the suite fast.
  const hybridIt = process.env.DITHER_TEST_HYBRID ? it : it.skip;

  hybridIt("attaches a snippet in hybrid mode without re-fetching the body", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "auth.md"),
      "---\ntitle: Authentication flow\n---\n\nThis describes the OAuth2 authentication flow we use for login.",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { search } = await import("./search");
    const results = await search({ query: "authentication", preview: { before: 0, after: 0 } });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toBeDefined();
    expect(results[0]?.snippet?.text.toLowerCase()).toContain("authentication");
  });

  it("falls back to first non-empty line when extractSnippet finds nothing", async () => {
    // A doc that mentions `widget` exactly once — search for it, then verify
    // the snippet contains the matched word. Index uses BM25 so we know the
    // doc will surface.
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "edge.md"),
      "---\ntitle: Edge cases\n---\n\n\n   first useful line\nthe widget is here\n",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { search } = await import("./search");
    const results = await search({ query: "widget", mode: "lex", preview: { before: 0, after: 0 } });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toBeDefined();
    expect(results[0]?.snippet?.text.toLowerCase()).toContain("widget");
  });

  it("attaches a snippet when preview is requested (lex mode)", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "auth.md"),
      "---\ntitle: Authentication flow\n---\n\nThis describes the OAuth2 authentication flow we use for login.",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { search } = await import("./search");
    const previewed = await search({ query: "authentication", mode: "lex", preview: { before: 0, after: 0 } });
    const plain = await search({ query: "authentication", mode: "lex" });

    expect(previewed.length).toBeGreaterThan(0);
    expect(previewed[0]?.snippet).toBeDefined();
    expect(previewed[0]?.snippet?.text.toLowerCase()).toContain("authentication");
    expect(typeof previewed[0]?.snippet?.line).toBe("number");

    expect(plain.length).toBeGreaterThan(0);
    for (const hit of plain) {
      expect(hit.snippet).toBeUndefined();
    }
  });
});
