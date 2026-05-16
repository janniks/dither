import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyQmdImport,
  discoverQmdCollections,
  type QmdDiscoveryResult,
} from "./qmd-import";
import type { DitherConfig } from "./config";

function emptyCfg(libraryPath: string): DitherConfig {
  return {
    schema: { version: 2 },
    library: { path: libraryPath },
    collections: { external: [] },
  };
}

function emptyResult(extras: Partial<QmdDiscoveryResult> = {}): QmdDiscoveryResult {
  return { source: null, collections: [], warnings: [], ...extras };
}

describe("applyQmdImport", () => {
  let tmp: string;
  let lib: string;
  let extA: string;
  let extB: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "qmd-import-apply-")));
    lib = join(tmp, "library");
    extA = join(tmp, "extA");
    extB = join(tmp, "extB");
    mkdirSync(lib, { recursive: true });
    mkdirSync(extA, { recursive: true });
    mkdirSync(extB, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("empty result leaves cfg untouched", () => {
    const cfg = emptyCfg(lib);
    const { cfg: next, diff } = applyQmdImport(cfg, emptyResult());
    expect(next).toEqual(cfg);
    expect(diff).toEqual({ adopted: [], skippedInLibrary: [], skippedInvalid: [] });
  });

  it("adopts a single external collection", () => {
    const cfg = emptyCfg(lib);
    const { cfg: next, diff } = applyQmdImport(cfg, {
      source: { path: "/tmp/fake", kind: "global" },
      collections: [{ name: "work", path: extA }],
      warnings: [],
    });
    expect(next.collections.external).toHaveLength(1);
    expect(next.collections.external[0]!.name).toBe("work");
    expect(diff.adopted).toHaveLength(1);
    expect(diff.adopted[0]!.renamedFrom).toBeUndefined();
  });

  it("skips a collection inside the library", () => {
    const inside = join(lib, "already");
    mkdirSync(inside);
    const { cfg: next, diff } = applyQmdImport(emptyCfg(lib), {
      source: { path: "/tmp/fake", kind: "global" },
      collections: [{ name: "inside", path: inside }],
      warnings: [],
    });
    expect(next.collections.external).toHaveLength(0);
    expect(diff.skippedInLibrary).toEqual(["inside"]);
  });

  it("renames on collision with a prior adopted external", () => {
    const { diff } = applyQmdImport(emptyCfg(lib), {
      source: { path: "/tmp/fake", kind: "global" },
      collections: [
        { name: "notes", path: extA },
        { name: "notes", path: extB },
      ],
      warnings: [],
    });
    expect(diff.adopted).toHaveLength(2);
    expect(diff.adopted[0]!.name).toBe("notes");
    expect(diff.adopted[1]!.name).toBe("notes-1");
    expect(diff.adopted[1]!.renamedFrom).toBe("notes");
  });

  it("renames on collision with an existing library subdir", () => {
    mkdirSync(join(lib, "notes"));
    const { diff } = applyQmdImport(emptyCfg(lib), {
      source: { path: "/tmp/fake", kind: "global" },
      collections: [{ name: "notes", path: extA }],
      warnings: [],
    });
    expect(diff.adopted).toHaveLength(1);
    expect(diff.adopted[0]!.name).toBe("notes-1");
    expect(diff.adopted[0]!.renamedFrom).toBe("notes");
  });

  it("sanitises a slash in the name", () => {
    const { diff } = applyQmdImport(emptyCfg(lib), {
      source: { path: "/tmp/fake", kind: "global" },
      collections: [{ name: "scope/notes", path: extA }],
      warnings: [],
    });
    expect(diff.adopted[0]!.name).toBe("scope-notes");
    expect(diff.adopted[0]!.renamedFrom).toBe("scope/notes");
  });

  it("reports invalid path as skippedInvalid", () => {
    const { diff } = applyQmdImport(emptyCfg(lib), {
      source: { path: "/tmp/fake", kind: "global" },
      collections: [{ name: "bad", path: join(tmp, "does-not-exist") }],
      warnings: [],
    });
    expect(diff.adopted).toHaveLength(0);
    expect(diff.skippedInvalid).toHaveLength(1);
    expect(diff.skippedInvalid[0]!.name).toBe("bad");
  });

  it("treats a symlink to a registered path as overlap (canonicalisation)", () => {
    const link = join(tmp, "extA-symlink");
    symlinkSync(extA, link);
    const { diff } = applyQmdImport(emptyCfg(lib), {
      source: { path: "/tmp/fake", kind: "global" },
      collections: [
        { name: "first", path: extA },
        { name: "second", path: link },
      ],
      warnings: [],
    });
    expect(diff.adopted).toHaveLength(1);
    expect(diff.skippedInvalid).toHaveLength(1);
    expect(diff.skippedInvalid[0]!.reason).toMatch(/overlap/i);
  });
});

describe("discoverQmdCollections", () => {
  let tmp: string;
  let lib: string;
  let prevXdg: string | undefined;
  let prevQmd: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "qmd-import-discover-")));
    lib = join(tmp, "library");
    mkdirSync(lib, { recursive: true });
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevQmd = process.env.QMD_CONFIG_DIR;
    // Point qmd's config-dir lookup at a definitely-empty location by default.
    process.env.QMD_CONFIG_DIR = join(tmp, "no-qmd-here");
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevQmd === undefined) delete process.env.QMD_CONFIG_DIR;
    else process.env.QMD_CONFIG_DIR = prevQmd;
    rmSync(tmp, { recursive: true, force: true });
  });

  // Tests below assume the .qmd / qmd-global parent dirs exist when called.
  const writeYaml = (path: string, body: string): void => writeFileSync(path, body, "utf-8");

  it("returns null source when no config exists", async () => {
    const r = await discoverQmdCollections(lib);
    expect(r.source).toBeNull();
    expect(r.collections).toEqual([]);
  });

  it("reads global config", async () => {
    const cfgDir = join(tmp, "qmd-global");
    mkdirSync(cfgDir);
    writeYaml(
      join(cfgDir, "index.yml"),
      "collections:\n  work:\n    path: /tmp/work\n  personal:\n    path: /tmp/personal\n",
    );
    process.env.QMD_CONFIG_DIR = cfgDir;
    const r = await discoverQmdCollections(lib);
    expect(r.source?.kind).toBe("global");
    expect(r.collections).toEqual([
      { name: "work", path: "/tmp/work" },
      { name: "personal", path: "/tmp/personal" },
    ]);
  });

  it("reads local .qmd/index.yaml walked up from library", async () => {
    const dotQmd = join(tmp, ".qmd");
    mkdirSync(dotQmd);
    writeYaml(
      join(dotQmd, "index.yaml"),
      "collections:\n  notes:\n    path: /tmp/notes\n",
    );
    const r = await discoverQmdCollections(lib);
    expect(r.source?.kind).toBe("local");
    expect(r.source?.path).toContain(".qmd/index.yaml");
    expect(r.collections).toEqual([{ name: "notes", path: "/tmp/notes" }]);
  });

  it("local wins on name conflict when both sources exist", async () => {
    const cfgDir = join(tmp, "qmd-global");
    mkdirSync(cfgDir);
    writeYaml(
      join(cfgDir, "index.yml"),
      "collections:\n  notes:\n    path: /tmp/global-notes\n  archive:\n    path: /tmp/archive\n",
    );
    process.env.QMD_CONFIG_DIR = cfgDir;
    const dotQmd = join(tmp, ".qmd");
    mkdirSync(dotQmd);
    writeYaml(
      join(dotQmd, "index.yml"),
      "collections:\n  notes:\n    path: /tmp/local-notes\n",
    );
    const r = await discoverQmdCollections(lib);
    expect(r.source?.kind).toBe("local");
    const notes = r.collections.find((c) => c.name === "notes");
    expect(notes?.path).toBe("/tmp/local-notes");
    // archive comes only from global — still present
    expect(r.collections.find((c) => c.name === "archive")?.path).toBe("/tmp/archive");
  });

  it("malformed YAML warns and falls back to empty", async () => {
    const cfgDir = join(tmp, "qmd-global");
    mkdirSync(cfgDir);
    writeYaml(join(cfgDir, "index.yml"), "collections:\n  : :\n  not yaml at all: [\n");
    process.env.QMD_CONFIG_DIR = cfgDir;
    const r = await discoverQmdCollections(lib);
    expect(r.collections).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]!).toMatch(/malformed/i);
  });
});
