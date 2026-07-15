import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "./paths";

describe("configDir — config dir lookup chain", () => {
  let prevDir: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevDir = process.env.DITHER_DIR;
    prevXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.DITHER_DIR;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevDir;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  it("DITHER_DIR wins over everything else", () => {
    process.env.DITHER_DIR = "/explicit";
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(configDir()).toBe("/explicit");
  });

  it("XDG_CONFIG_HOME wins when DITHER_DIR is unset", () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(configDir()).toBe("/xdg/dither");
  });

  it("falls back to ~/.dither when nothing is set", () => {
    expect(configDir()).toBe(join(homedir(), ".dither"));
  });
});
