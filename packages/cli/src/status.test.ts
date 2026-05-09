import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

  it("returns null library when not yet configured", async () => {
    const s = await getStatus();
    expect(s.library).toBeNull();
    expect(s.collections).toBe(0);
    expect(s.entries).toBe(0);
  });

  it("returns library.path from config when configured (nested default)", async () => {
    const lib = join(home, "library");
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
    );
    const s = await getStatus();
    expect(s.library).toBe(lib);
  });

  it("returns library.path from config when configured to a separate location", async () => {
    const lib = mkdtempSync(join(tmpdir(), "dither-lib-test-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
    );
    try {
      const s = await getStatus();
      expect(s.library).toBe(lib);
      expect(s.configDir).toBe(home);
      expect(s.library).not.toBe(join(s.configDir, "library"));
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });
});
