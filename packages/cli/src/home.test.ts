import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { _resetHomeWarningLatch, resolveHome } from "./home";

describe("resolveHome — config dir lookup chain", () => {
  let prevDir: string | undefined;
  let prevXdg: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevDir = process.env.DITHER_DIR;
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevHome = process.env.DITHER_HOME;
    delete process.env.DITHER_DIR;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.DITHER_HOME;
    _resetHomeWarningLatch();
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevDir;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
  });

  it("DITHER_DIR wins over everything else", () => {
    process.env.DITHER_DIR = "/explicit";
    process.env.XDG_CONFIG_HOME = "/xdg";
    process.env.DITHER_HOME = "/legacy";
    expect(resolveHome()).toBe("/explicit");
  });

  it("XDG_CONFIG_HOME wins when DITHER_DIR is unset", () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    process.env.DITHER_HOME = "/legacy";
    expect(resolveHome()).toBe("/xdg/dither");
  });

  it("DITHER_HOME alias resolves and warns once", () => {
    process.env.DITHER_HOME = "/legacy";
    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(resolveHome()).toBe("/legacy");
      expect(resolveHome()).toBe("/legacy");
    } finally {
      process.stderr.write = origWrite;
    }
    expect(stderr).toContain("DITHER_HOME is deprecated");
    expect(stderr.match(/DITHER_HOME is deprecated/g)?.length).toBe(1);
  });

  it("falls back to ~/.dither when nothing is set", () => {
    expect(resolveHome()).toBe(join(homedir(), ".dither"));
  });
});
