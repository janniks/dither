import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

describe("dither init (Phase 1)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-init-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes config.json with the default library path inside dither home", async () => {
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init"] });
    });

    expect(existsSync(join(home, "config.json"))).toBe(true);
    const { loadConfig } = await import("../config");
    const cfg = await loadConfig();
    expect(cfg).toEqual({
      schema: { version: 1 },
      library: { path: realpathSync(join(home, "library")) },
    });
    expect(existsSync(join(home, "library"))).toBe(true);
  });

  it("re-running init prints existing config and does not overwrite", async () => {
    const { saveConfig } = await import("../config");
    await saveConfig({
      schema: { version: 1 },
      library: { path: "/somewhere/else" },
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
});
