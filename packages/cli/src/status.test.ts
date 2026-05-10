import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetHomeWarningLatch } from "./home";
import { getStatus } from "./status";

describe("getStatus — config dir + library split", () => {
  let home: string;
  let prevDir: string | undefined;
  let prevXdg: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevDir = process.env.DITHER_DIR;
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevHome = process.env.DITHER_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.DITHER_HOME;
    home = mkdtempSync(join(tmpdir(), "dither-status-test-"));
    process.env.DITHER_DIR = home;
    _resetHomeWarningLatch();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevDir;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
  });

  it("returns configDir from the resolver", async () => {
    const s = await getStatus();
    expect(s.configDir).toBe(home);
  });

  it("retains `home` as a deprecated alias of configDir", async () => {
    const s = await getStatus();
    expect(s.home).toBe(s.configDir);
  });

  describe("libraryHealth", () => {
    it("'unconfigured' when no config file exists", async () => {
      const s = await getStatus();
      expect(s.libraryHealth).toBe("unconfigured");
      expect(s.library).toBeNull();
      expect(s.collections).toBeNull();
      expect(s.entries).toBeNull();
    });

    it("'ok' for a healthy nested-default library", async () => {
      const lib = join(home, "library");
      mkdirSync(lib, { recursive: true });
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
      );
      const s = await getStatus();
      expect(s.libraryHealth).toBe("ok");
      expect(s.library).toBe(lib);
      expect(s.collections).toBe(0);
      expect(s.entries).toBe(0);
    });

    it("'ok' counts collections + entries from on-disk markdown", async () => {
      const lib = join(home, "library");
      mkdirSync(join(lib, "notes"), { recursive: true });
      mkdirSync(join(lib, "links"), { recursive: true });
      writeFileSync(join(lib, "notes", "a.md"), "# a");
      writeFileSync(join(lib, "notes", "b.md"), "# b");
      writeFileSync(join(lib, "links", "c.md"), "# c");
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
      );
      const s = await getStatus();
      expect(s.libraryHealth).toBe("ok");
      expect(s.collections).toBe(2);
      expect(s.entries).toBe(3);
    });

    it("'missing' when library.path does not exist on disk", async () => {
      const ghost = join(tmpdir(), "dither-ghost-library-that-never-was");
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ schema: { version: 1 }, library: { path: ghost } }),
      );
      const s = await getStatus();
      expect(s.libraryHealth).toBe("missing");
      expect(s.library).toBe(ghost);
      expect(s.collections).toBeNull();
      expect(s.entries).toBeNull();
    });

    it("'unreadable' when library.path exists but is not readable", async () => {
      const lib = mkdtempSync(join(tmpdir(), "dither-unreadable-lib-"));
      chmodSync(lib, 0o000);
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
      );
      try {
        const s = await getStatus();
        expect(s.libraryHealth).toBe("unreadable");
        expect(s.library).toBe(lib);
        expect(s.collections).toBeNull();
        expect(s.entries).toBeNull();
      } finally {
        chmodSync(lib, 0o700);
        rmSync(lib, { recursive: true, force: true });
      }
    });
  });

  describe("configDirSource", () => {
    it("'env' when DITHER_DIR is set", async () => {
      const s = await getStatus();
      expect(s.configDirSource).toBe("env");
    });

    it("'env' for legacy DITHER_HOME alias", async () => {
      delete process.env.DITHER_DIR;
      process.env.DITHER_HOME = home;
      const s = await getStatus();
      expect(s.configDirSource).toBe("env");
    });

    it("'xdg' when only XDG_CONFIG_HOME is set", async () => {
      delete process.env.DITHER_DIR;
      process.env.XDG_CONFIG_HOME = tmpdir();
      const s = await getStatus();
      expect(s.configDirSource).toBe("xdg");
    });

    it("'fallback' when nothing is set", async () => {
      delete process.env.DITHER_DIR;
      const s = await getStatus();
      expect(s.configDirSource).toBe("fallback");
    });
  });
});
