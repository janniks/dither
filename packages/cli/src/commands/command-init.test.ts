import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { defaultLibraryPath } from "./command-init";

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  // prompt.ts helpers (confirm, stepStart, stepDone, stepFail) write directly
  // to stdout, bypass console.log — capture them too.
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    if (typeof chunk === "string") logs.push(chunk.replace(/\n$/, ""));
    return true;
  }) as never);
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return logs.join("\n");
}

describe("dither init (Phase 1)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevQmd: string | undefined;
  let prevXdgConfig: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-init-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    // Isolate from a developer's real qmd setup at ~/.config/qmd — otherwise
    // adoption fires unexpectedly during these tests. Point at a guaranteed-
    // empty location.
    prevQmd = process.env.QMD_CONFIG_DIR;
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    process.env.QMD_CONFIG_DIR = join(home, "no-qmd-here");
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    if (prevQmd === undefined) delete process.env.QMD_CONFIG_DIR;
    else process.env.QMD_CONFIG_DIR = prevQmd;
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    rmSync(home, { recursive: true, force: true });
  });

  it("--library <DITHER_DIR>/library writes config with the nested-default path", async () => {
    const lib = join(home, "library");
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init", "--library", lib, "--no-download"] });
    });

    expect(existsSync(join(home, "config.json"))).toBe(true);
    const { loadConfig } = await import("../config");
    const cfg = await loadConfig();
    expect(cfg).toEqual({
      schema: { version: 2 },
      library: { path: realpathSync(lib) },
      collections: { external: [] },
    });
    expect(existsSync(lib)).toBe(true);
  });

  it("non-TTY without --library errors with a helpful message", async () => {
    const { main } = await import("../main");
    const stderr: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      stderr.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      await expect(
        captureLogs(async () => {
          await runCommand(main, { rawArgs: ["init"] });
        }),
      ).rejects.toThrow(/process\.exit\(2\)/);
      expect(stderr.join("\n")).toContain("--library is required");
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  it("re-running init prints existing config and does not overwrite", async () => {
    const { saveConfig } = await import("../config");
    await saveConfig({
      schema: { version: 2 },
      library: { path: "/somewhere/else" },
      collections: { external: [] },
    });

    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init"] });
    });

    expect(out).toContain("already initialized");
    expect(out).toContain("/somewhere/else");

    // Confirm we didn't overwrite.
    const { loadConfig } = await import("../config");
    const cfg = await loadConfig();
    expect(cfg?.library.path).toBe("/somewhere/else");
  });

  it("re-running init never wipes existing grants or library files", async () => {
    // Hard guarantee: a second `dither init` on an already-initialized
    // install must touch nothing the user has accumulated — not grants,
    // not library content. It returns early before any fs write.
    const { saveConfig } = await import("../config");
    const lib = join(home, "library");
    mkdirSync(join(lib, "twitter", "likes"), { recursive: true });
    const likeFile = join(lib, "twitter", "likes", "1.md");
    writeFileSync(likeFile, "---\nid: 1\n---\nliked\n", "utf-8");
    const grantsDir = join(home, "grants");
    mkdirSync(grantsDir, { recursive: true });
    const grantFile = join(grantsDir, "twitter-import.json");
    writeFileSync(grantFile, '{"net":["api.twitter.com"]}', "utf-8");
    await saveConfig({
      schema: { version: 2 },
      library: { path: lib },
      collections: { external: [] },
    });

    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init"] });
    });

    const { readFileSync } = await import("node:fs");
    expect(readFileSync(likeFile, "utf-8")).toBe("---\nid: 1\n---\nliked\n");
    expect(readFileSync(grantFile, "utf-8")).toBe('{"net":["api.twitter.com"]}');
  });

  it("re-running init with --library notes the flag is ignored", async () => {
    const { saveConfig } = await import("../config");
    await saveConfig({
      schema: { version: 2 },
      library: { path: "/somewhere/else" },
      collections: { external: [] },
    });

    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init", "--library", "/anywhere"] });
    });

    expect(out).toContain("already initialized");
    expect(out).toContain("--library ignored");

    const { loadConfig } = await import("../config");
    const cfg = await loadConfig();
    expect(cfg?.library.path).toBe("/somewhere/else");
  });

  it("library-needing commands refuse with NotInitializedError before init", async () => {
    const { main } = await import("../main");
    await expect(runCommand(main, { rawArgs: ["search", "anything"] })).rejects.toThrow(
      /dither is not initialized/,
    );
  });

  it("plugin install refuses before init", async () => {
    const { main } = await import("../main");
    await expect(
      runCommand(main, { rawArgs: ["plugin", "install", "/tmp/nonexistent"] }),
    ).rejects.toThrow(/dither is not initialized/);
  });

  it("index update refuses before init", async () => {
    const { main } = await import("../main");
    await expect(runCommand(main, { rawArgs: ["index", "update"] })).rejects.toThrow(
      /dither is not initialized/,
    );
  });

  it("daemon start refuses before init", async () => {
    const { main } = await import("../main");
    await expect(runCommand(main, { rawArgs: ["daemon", "start"] })).rejects.toThrow(
      /dither is not initialized/,
    );
  });

  it("--library <existing dir> adopts it as the library path (canonicalised)", async () => {
    const externalLib = mkdtempSync(join(tmpdir(), "dither-init-extlib-"));
    try {
      const { main } = await import("../main");
      await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["init", "--library", externalLib] });
      });
      const { loadConfig } = await import("../config");
      const cfg = await loadConfig();
      expect(cfg?.library.path).toBe(realpathSync(externalLib));
    } finally {
      rmSync(externalLib, { recursive: true, force: true });
    }
  });

  it("--library <new path> creates the directory and reports it", async () => {
    const newLib = join(home, "new-library-dir");
    expect(existsSync(newLib)).toBe(false);

    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init", "--library", newLib] });
    });

    expect(existsSync(newLib)).toBe(true);
    expect(out).toContain("(created)");
    const { loadConfig } = await import("../config");
    const cfg = await loadConfig();
    expect(cfg?.library.path).toBe(realpathSync(newLib));
  });

  it("--library <existing dir with files> leaves contents untouched", async () => {
    // Regression: pointing --library at a directory that already holds
    // entries (e.g. a previously-synced library, or a Documents folder the
    // user wants to adopt) must not delete, rewrite, or move any of those
    // files. Init is non-destructive against the library tree.
    const externalLib = mkdtempSync(join(tmpdir(), "dither-init-existing-"));
    const collectionDir = join(externalLib, "raindrop", "bookmarks");
    mkdirSync(collectionDir, { recursive: true });
    const topFile = join(externalLib, "top.md");
    const nestedFile = join(collectionDir, "1.md");
    const nestedAsset = join(collectionDir, "asset.bin");
    writeFileSync(topFile, "# top\n", "utf-8");
    writeFileSync(nestedFile, "---\nid: 1\n---\nbody\n", "utf-8");
    writeFileSync(nestedAsset, "raw-bytes", "utf-8");

    try {
      const { main } = await import("../main");
      await captureLogs(async () => {
        await runCommand(main, {
          rawArgs: ["init", "--library", externalLib, "--no-download"],
        });
      });

      const { readFileSync } = await import("node:fs");
      expect(readFileSync(topFile, "utf-8")).toBe("# top\n");
      expect(readFileSync(nestedFile, "utf-8")).toBe("---\nid: 1\n---\nbody\n");
      expect(readFileSync(nestedAsset, "utf-8")).toBe("raw-bytes");
    } finally {
      rmSync(externalLib, { recursive: true, force: true });
    }
  });

  it("--library <file path> errors out", async () => {
    const filePath = join(home, "not-a-dir.txt");
    writeFileSync(filePath, "hi", "utf-8");

    const { main } = await import("../main");
    await expect(runCommand(main, { rawArgs: ["init", "--library", filePath] })).rejects.toThrow(
      /not a directory/,
    );

    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  it("--library <unwritable dir> errors out", async () => {
    const unwritable = mkdtempSync(join(tmpdir(), "dither-init-unwritable-"));
    chmodSync(unwritable, 0o500); // r-x only
    try {
      const { main } = await import("../main");
      await expect(
        runCommand(main, { rawArgs: ["init", "--library", unwritable] }),
      ).rejects.toThrow(/not writable/);
    } finally {
      chmodSync(unwritable, 0o700);
      rmSync(unwritable, { recursive: true, force: true });
    }
  });

  it("--library <symlinked dir> canonicalises to the real target", async () => {
    const realDir = mkdtempSync(join(tmpdir(), "dither-init-realdir-"));
    const linkPath = join(home, "link-to-real");
    symlinkSync(realDir, linkPath, "dir");

    try {
      const { main } = await import("../main");
      await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["init", "--library", linkPath] });
      });
      const { loadConfig } = await import("../config");
      const cfg = await loadConfig();
      // Config records the real target, not the symlink path.
      expect(cfg?.library.path).toBe(realpathSync(realDir));
      expect(cfg?.library.path).not.toBe(linkPath);
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("qmd index lives in dither home regardless of --library", async () => {
    const externalLib = mkdtempSync(join(tmpdir(), "dither-init-extlib-idx-"));
    try {
      const { main } = await import("../main");
      await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["init", "--library", externalLib] });
      });
      // The index file isn't actually created until the first store.update();
      // what matters is the resolved path. We check that the home-relative
      // path is what the resolver returns.
      const { indexDbPath } = await import("../home");
      expect(indexDbPath()).toBe(join(home, "qmd-index.sqlite"));
    } finally {
      rmSync(externalLib, { recursive: true, force: true });
    }
  });

  it("--no-download annotates the summary and skips prefetch", async () => {
    const lib = join(home, "library");
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init", "--library", lib, "--no-download"] });
    });
    expect(out).toContain("--no-download");
    expect(existsSync(join(home, "config.json"))).toBe(true);
  });

  describe("defaultLibraryPath", () => {
    let prevXdg: string | undefined;
    beforeEach(() => {
      prevXdg = process.env.XDG_DATA_HOME;
    });
    afterEach(() => {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    });

    it("falls back to ~/.dither/library when XDG_DATA_HOME is unset", () => {
      delete process.env.XDG_DATA_HOME;
      expect(defaultLibraryPath()).toBe(join(homedir(), ".dither", "library"));
    });

    it("uses $XDG_DATA_HOME/dither when set", () => {
      process.env.XDG_DATA_HOME = "/tmp/xdg-data";
      expect(defaultLibraryPath()).toBe("/tmp/xdg-data/dither");
    });

    it("ignores DITHER_DIR — library default does not follow the config dir", () => {
      // Custom config dir is already in scope via the outer beforeEach
      // (process.env.DITHER_DIR = home). The library default must still
      // land at the user's home, not inside the config dir.
      delete process.env.XDG_DATA_HOME;
      expect(defaultLibraryPath()).toBe(join(homedir(), ".dither", "library"));
    });
  });

  it("end-of-init epilogue points at the welcome doc by default", async () => {
    const lib = join(home, "library");
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init", "--library", lib, "--no-download"] });
    });
    expect(out).toContain("wrote welcome doc to");
    expect(out).toContain("dither search 'welcome to dither'");
    expect(out).toContain("dither get <id from above>");
    expect(existsSync(join(realpathSync(lib), "welcome", "welcome.md"))).toBe(true);
  });

  it("--no-wait is accepted and doesn't break the flow", async () => {
    // In test mode the entire daemon-watch branch is skipped, so the
    // flag's only observable effect there is that it's accepted as an
    // option. The behavior in production (dispatch + exit) is exercised
    // manually; this test guards against regressing the flag schema.
    const lib = join(home, "library");
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["init", "--library", lib, "--no-download", "--no-wait"],
      });
    });
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect(out).toContain("--no-download");
  });

  it("--no-welcome skips the welcome doc and falls back to the plugin-install nudge", async () => {
    const lib = join(home, "library");
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["init", "--library", lib, "--no-download", "--no-welcome"],
      });
    });
    expect(out).toContain("next: dither plugin install");
    expect(out).not.toContain("wrote welcome doc to");
    expect(existsSync(join(realpathSync(lib), "welcome", "welcome.md"))).toBe(false);
  });

  it("preserves a pre-existing welcome doc on re-init (idempotent)", async () => {
    const lib = join(home, "library");
    // Create the library and a pre-existing welcome doc before init runs.
    mkdirSync(join(lib, "welcome"), { recursive: true });
    const customPath = join(lib, "welcome", "welcome.md");
    writeFileSync(customPath, "I edited this welcome doc.", "utf-8");
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init", "--library", lib, "--no-download"] });
    });
    // Init shouldn't claim it wrote the doc — it already existed.
    expect(out).not.toContain("wrote welcome doc to");
    // Epilogue still references the welcome doc since it's present.
    expect(out).toContain("dither search 'welcome to dither'");
    // And the user's edits survive.
    expect(readFileSync(customPath, "utf-8")).toBe("I edited this welcome doc.");
  });

  describe("qmd adoption", () => {
    it("adopts external collections defined in qmd's global config", async () => {
      const qmdDir = join(home, "qmd-global");
      mkdirSync(qmdDir, { recursive: true });
      const extA = realpathSync(mkdtempSync(join(tmpdir(), "dither-init-qmd-a-")));
      const extB = realpathSync(mkdtempSync(join(tmpdir(), "dither-init-qmd-b-")));
      writeFileSync(
        join(qmdDir, "index.yml"),
        `collections:\n  work:\n    path: ${extA}\n  personal:\n    path: ${extB}\n`,
        "utf-8",
      );
      process.env.QMD_CONFIG_DIR = qmdDir;

      const lib = join(home, "library");
      const { main } = await import("../main");
      const out = await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["init", "--library", lib, "--no-download"] });
      });

      try {
        expect(out).toContain("found qmd config");
        expect(out).toMatch(/adopted 2 collections: work, personal/);
        const { loadConfig } = await import("../config");
        const cfg = await loadConfig();
        expect(cfg?.collections.external.map((e) => e.name).sort()).toEqual(["personal", "work"]);
      } finally {
        rmSync(extA, { recursive: true, force: true });
        rmSync(extB, { recursive: true, force: true });
      }
    });

    it("is silent when no qmd config is present", async () => {
      const lib = join(home, "library");
      const { main } = await import("../main");
      const out = await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["init", "--library", lib, "--no-download"] });
      });
      expect(out).not.toContain("qmd config");
      expect(out).not.toContain("adopted");
    });
  });

  describe("resolveLibraryPath dry-run", () => {
    it("does not create the directory when dryRun is true", async () => {
      const target = join(home, "validator-probe");
      expect(existsSync(target)).toBe(false);

      const { resolveLibraryPath } = await import("./command-init");
      const out = await resolveLibraryPath(target, { dryRun: true });

      expect(existsSync(target)).toBe(false);
      expect(out.created).toBe(true);
    });

    it("rejects an unwritable parent without creating anything", async () => {
      const { resolveLibraryPath } = await import("./command-init");
      await expect(
        resolveLibraryPath("/usr/local/etc/forbidden-dither", { dryRun: true }),
      ).rejects.toThrow(/parent directory/);
    });
  });
});
