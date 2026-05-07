import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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

  it("writes config.json with the implicit-default library path", async () => {
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["init"] });
    });

    expect(existsSync(join(home, "config.json"))).toBe(true);
    const { loadConfig } = await import("../config");
    const cfg = await loadConfig();
    expect(cfg).toEqual({
      schema: { version: 1 },
      library: { path: join(home, "entries") },
    });
    expect(existsSync(join(home, "entries"))).toBe(true);
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
});
