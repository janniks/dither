import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("get", () => {
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

  it("returns full content for an entry by display path", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "auth.md"),
      "---\ntitle: Authentication flow\n---\n\nLine A.\nLine B.\nLine C.\n",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { get } = await import("./get");
    const content = await get({ ref: "notes/auth.md" });

    expect(content).not.toBeNull();
    expect(content).toContain("Line A.");
    expect(content).toContain("Line C.");
  });

  it("returns only the requested line range when fromLine/toLine given", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "ranges.md"),
      [
        "Line 1",
        "Line 2",
        "Line 3",
        "Line 4",
        "Line 5",
        "Line 6",
        "Line 7",
        "Line 8",
        "Line 9",
        "",
      ].join("\n"),
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { get } = await import("./get");
    const slice = await get({ ref: "notes/ranges.md", fromLine: 3, toLine: 5 });

    expect(slice).not.toBeNull();
    expect(slice).toContain("Line 3");
    expect(slice).toContain("Line 4");
    expect(slice).toContain("Line 5");
    expect(slice).not.toContain("Line 1");
    expect(slice).not.toContain("Line 7");
  });
});
