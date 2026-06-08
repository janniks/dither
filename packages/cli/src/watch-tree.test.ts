import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchTree } from "./watch-tree";

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

describe("watchTree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dither-watchtree-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("emits an absolute path for a file created under a root", async () => {
    const seen: string[] = [];
    const h = watchTree([root], (p) => seen.push(p));
    await settle();

    const file = join(root, "a.md");
    writeFileSync(file, "hi");
    await settle();
    h.close();

    expect(seen.includes(file)).toBe(true);
  });

  it("stops emitting after close()", async () => {
    const seen: string[] = [];
    const h = watchTree([root], (p) => seen.push(p));
    await settle();
    h.close();

    writeFileSync(join(root, "after.md"), "x");
    await settle();

    expect(seen.some((p) => p.endsWith("after.md"))).toBe(false);
  });

  it("does not emit for directories (only files)", async () => {
    const seen: string[] = [];
    const h = watchTree([root], (p) => seen.push(p));
    await settle();

    mkdirSync(join(root, "sub"));
    await settle();
    h.close();

    expect(seen.some((p) => p.endsWith("/sub"))).toBe(false);
  });

  it("watches a subdirectory created after start", async () => {
    const seen: string[] = [];
    const h = watchTree([root], (p) => seen.push(p));
    await settle();

    const sub = join(root, "nested");
    mkdirSync(sub);
    await settle();
    const file = join(sub, "deep.md");
    writeFileSync(file, "deep");
    await settle();
    h.close();

    expect(seen.some((p) => p === file)).toBe(true);
  });
});
