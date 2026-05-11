import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addExternal,
  defaultSlug,
  loadRegistry,
  removeExternal,
  resolveCollection,
  type Collection,
} from "./collection-registry";
import type { DitherConfig } from "./config";

function emptyCfg(libraryPath: string): DitherConfig {
  return {
    schema: { version: 2 },
    library: { path: libraryPath },
    collections: { external: [] },
  };
}

describe("collection-registry", () => {
  let root: string;
  let library: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dither-registry-"));
    library = realpathSync(mkdtempSync(join(root, "lib-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("defaultSlug", () => {
    it("lowercases and replaces spaces with -", () => {
      expect(defaultSlug("/tmp/Work Notes")).toBe("work-notes");
    });
    it("collapses runs of non-allowed chars to a single -", () => {
      expect(defaultSlug("/tmp/foo--bar//baz")).toBe("baz");
      expect(defaultSlug("/tmp/foo  bar")).toBe("foo-bar");
    });
    it("trims leading and trailing -", () => {
      expect(defaultSlug("/tmp/-weird-")).toBe("weird");
    });
    it("tolerates a trailing slash", () => {
      expect(defaultSlug("/tmp/Work Notes/")).toBe("work-notes");
    });
    it("returns empty when nothing survives sanitisation", () => {
      expect(defaultSlug("/tmp/!!!")).toBe("");
    });
    it("preserves dots underscores and dashes", () => {
      expect(defaultSlug("/tmp/a_b.c-d")).toBe("a_b.c-d");
    });
  });

  describe("addExternal — path checks", () => {
    it("errors when the path does not exist", () => {
      const cfg = emptyCfg(library);
      expect(() => addExternal(cfg, join(root, "nope"))).toThrow(/does not exist/);
    });

    it("errors when the path is a file, not a directory", () => {
      const file = join(root, "file.txt");
      writeFileSync(file, "hi");
      expect(() => addExternal(emptyCfg(library), file)).toThrow(/not a directory/);
    });

    it("errors when the path is not writable", () => {
      const dir = mkdtempSync(join(root, "ro-"));
      chmodSync(dir, 0o500);
      try {
        expect(() => addExternal(emptyCfg(library), dir)).toThrow(/not writable/);
      } finally {
        chmodSync(dir, 0o700);
      }
    });

    it("canonicalises symlinks before storing", () => {
      const real = realpathSync(mkdtempSync(join(root, "real-")));
      const { symlinkSync } = require("node:fs") as typeof import("node:fs");
      const link = join(root, "link");
      symlinkSync(real, link, "dir");
      const out = addExternal(emptyCfg(library), link);
      expect(out.entry.path).toBe(real);
    });
  });

  describe("addExternal — overlap with library", () => {
    it("rejects a path inside the library", () => {
      const inside = join(library, "inner");
      mkdirSync(inside);
      expect(() => addExternal(emptyCfg(library), inside)).toThrow(/overlaps the library/);
    });

    it("rejects a path that contains the library", () => {
      // libraryParent is an ancestor of library.
      const parent = realpathSync(mkdtempSync(join(root, "outer-")));
      const innerLib = realpathSync(mkdtempSync(join(parent, "lib-")));
      const cfg = emptyCfg(innerLib);
      expect(() => addExternal(cfg, parent)).toThrow(/overlaps the library/);
    });

    it("rejects the library itself", () => {
      expect(() => addExternal(emptyCfg(library), library)).toThrow(/overlaps the library/);
    });
  });

  describe("addExternal — overlap with another external", () => {
    it("rejects a path inside an existing external", () => {
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      const cfg = addExternal(emptyCfg(library), ext, "ext").cfg;
      const inner = join(ext, "inner");
      mkdirSync(inner);
      expect(() => addExternal(cfg, inner, "inner")).toThrow(/overlaps existing external/);
    });

    it("rejects a path that contains an existing external", () => {
      const parent = realpathSync(mkdtempSync(join(root, "outer-")));
      const child = realpathSync(mkdtempSync(join(parent, "inner-")));
      const cfg = addExternal(emptyCfg(library), child, "inner").cfg;
      expect(() => addExternal(cfg, parent, "outer")).toThrow(/overlaps existing external/);
    });

    it("rejects re-adding the same path", () => {
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      const cfg = addExternal(emptyCfg(library), ext, "ext").cfg;
      expect(() => addExternal(cfg, ext, "ext2")).toThrow(/overlaps existing external/);
    });
  });

  describe("addExternal — name rules", () => {
    it("rejects a name containing /", () => {
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      expect(() => addExternal(emptyCfg(library), ext, "work/notes")).toThrow(
        /must not contain '\/'/,
      );
    });

    it("rejects a name with disallowed characters", () => {
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      expect(() => addExternal(emptyCfg(library), ext, "foo bar")).toThrow();
    });

    it("rejects an empty default slug", () => {
      // basename made up entirely of disallowed chars sanitises to "" → NAME_EMPTY.
      const dir = join(root, "!!!");
      mkdirSync(dir);
      expect(() => addExternal(emptyCfg(library), dir)).toThrow(/empty after sanitising/);
    });

    it("rejects a name collision with a library subdir (case-insensitive)", () => {
      mkdirSync(join(library, "Notes"));
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      expect(() => addExternal(emptyCfg(library), ext, "notes")).toThrow(/library subdir/);
    });

    it("rejects a name collision with an existing external (case-insensitive)", () => {
      const a = realpathSync(mkdtempSync(join(root, "a-")));
      const b = realpathSync(mkdtempSync(join(root, "b-")));
      const cfg = addExternal(emptyCfg(library), a, "Work").cfg;
      expect(() => addExternal(cfg, b, "work")).toThrow(/external collection 'Work'/);
    });
  });

  describe("addExternal — success", () => {
    it("returns an updated config with the new entry appended", () => {
      const ext = realpathSync(mkdtempSync(join(root, "work-notes-")));
      const out = addExternal(emptyCfg(library), ext);
      expect(out.entry.name).toBeTruthy();
      expect(out.entry.path).toBe(ext);
      expect(out.cfg.collections.external).toEqual([out.entry]);
    });

    it("honors an explicit --name", () => {
      const ext = realpathSync(mkdtempSync(join(root, "anything-")));
      const out = addExternal(emptyCfg(library), ext, "custom");
      expect(out.entry.name).toBe("custom");
    });
  });

  describe("removeExternal", () => {
    it("round-trips: add then remove returns equivalent config", () => {
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      const start = emptyCfg(library);
      const added = addExternal(start, ext, "ext").cfg;
      const back = removeExternal(added, "ext");
      expect(back).toEqual(start);
    });

    it("errors when the name isn't registered", () => {
      expect(() => removeExternal(emptyCfg(library), "ghost")).toThrow(/no external collection/);
    });

    it("refuses to remove a library subdir", () => {
      mkdirSync(join(library, "notes"));
      expect(() => removeExternal(emptyCfg(library), "notes")).toThrow(/library subdir/);
    });
  });

  describe("loadRegistry", () => {
    it("returns library subdirs and externals tagged by source", () => {
      mkdirSync(join(library, "notes"));
      mkdirSync(join(library, "messages"));
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      const cfg = addExternal(emptyCfg(library), ext, "work").cfg;
      const out = loadRegistry(cfg);
      const bySource = Object.fromEntries(
        out.map((c: Collection) => [c.name, c.source]),
      );
      expect(bySource).toEqual({ notes: "library", messages: "library", work: "external" });
    });

    it("flags a missing external as status='missing'", () => {
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      const cfg = addExternal(emptyCfg(library), ext, "work").cfg;
      rmSync(ext, { recursive: true, force: true });
      const out = loadRegistry(cfg);
      expect(out.find((c) => c.name === "work")?.status).toBe("missing");
    });
  });

  describe("resolveCollection", () => {
    it("returns external entries first when names match", () => {
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      const cfg = addExternal(emptyCfg(library), ext, "work").cfg;
      const got = resolveCollection(cfg, "work");
      expect(got?.source).toBe("external");
      expect(got?.path).toBe(ext);
      expect(got?.status).toBe("ok");
    });

    it("returns library entries when no external matches", () => {
      mkdirSync(join(library, "notes"));
      const got = resolveCollection(emptyCfg(library), "notes");
      expect(got?.source).toBe("library");
      expect(got?.path).toBe(join(library, "notes"));
    });

    it("returns undefined for unknown names", () => {
      expect(resolveCollection(emptyCfg(library), "ghost")).toBeUndefined();
    });

    it("reports missing status when external path is gone", () => {
      const ext = realpathSync(mkdtempSync(join(root, "ext-")));
      const cfg = addExternal(emptyCfg(library), ext, "work").cfg;
      rmSync(ext, { recursive: true, force: true });
      expect(resolveCollection(cfg, "work")?.status).toBe("missing");
    });
  });
});
