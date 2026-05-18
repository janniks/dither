import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WELCOME_COLLECTION_DIR,
  WELCOME_DOC_FILENAME,
  welcomeDocExists,
  welcomeDocPath,
  writeWelcomeIfMissing,
} from "./welcome-doc";

describe("welcome-doc", () => {
  let lib: string;

  beforeEach(() => {
    lib = mkdtempSync(join(tmpdir(), "dither-welcome-test-"));
  });

  afterEach(() => {
    rmSync(lib, { recursive: true, force: true });
  });

  it("welcomeDocPath resolves to <library>/welcome/welcome.md", () => {
    expect(welcomeDocPath(lib)).toBe(join(lib, WELCOME_COLLECTION_DIR, WELCOME_DOC_FILENAME));
  });

  it("welcomeDocExists returns false on a fresh library", () => {
    expect(welcomeDocExists(lib)).toBe(false);
  });

  it("writeWelcomeIfMissing creates the file and reports written=true", async () => {
    const result = await writeWelcomeIfMissing(lib);
    expect(result.written).toBe(true);
    expect(result.path).toBe(welcomeDocPath(lib));
    const content = readFileSync(result.path, "utf-8");
    expect(content).toMatch(/# Welcome to dither/);
    expect(content).toMatch(/dither search 'welcome to dither'/);
    expect(content).toMatch(/dither get <id from above>/);
  });

  it("writeWelcomeIfMissing is idempotent and never overwrites edits", async () => {
    const first = await writeWelcomeIfMissing(lib);
    expect(first.written).toBe(true);
    writeFileSync(first.path, "I edited this", "utf-8");
    const second = await writeWelcomeIfMissing(lib);
    expect(second.written).toBe(false);
    expect(readFileSync(second.path, "utf-8")).toBe("I edited this");
  });

  it("creates the welcome/ subdir if absent", async () => {
    expect(welcomeDocExists(lib)).toBe(false);
    await writeWelcomeIfMissing(lib);
    expect(welcomeDocExists(lib)).toBe(true);
  });

  it("welcomeDocExists returns true after writing", async () => {
    await writeWelcomeIfMissing(lib);
    expect(welcomeDocExists(lib)).toBe(true);
  });

  it("handles a pre-existing welcome/ directory with no doc inside", async () => {
    mkdirSync(join(lib, WELCOME_COLLECTION_DIR));
    const result = await writeWelcomeIfMissing(lib);
    expect(result.written).toBe(true);
    expect(welcomeDocExists(lib)).toBe(true);
  });
});
