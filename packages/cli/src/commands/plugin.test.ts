import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("dither plugin command", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "dither-plugin-cmd-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    const { writeTestConfig } = await import("../../test/helpers/config");
    await writeTestConfig(join(home, "entries"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.resetModules();
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("preserves run options when detaching an installed plugin", async () => {
    const spawn = vi.fn((_cmd: string, _args: string[]) => ({
      pid: 12345,
      unref: () => undefined,
    }));
    vi.doMock("node:child_process", () => ({ spawn }));

    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: [
          "plugin",
          "run",
          "watcher",
          "--backfill",
          "--detach",
          "--verbose",
          "--env",
          "TOKEN=abc",
          "--allow-env",
          "API_TOKEN",
          "--file",
          "SOURCE=/tmp/source.md",
          "--allow-net",
          "api.example.com",
          "--allow-collection",
          "notes",
        ],
      });
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![1]).toEqual([
      process.argv[1],
      "plugin",
      "run",
      "watcher",
      "--backfill",
      "--verbose",
      "--env",
      "TOKEN=abc",
      "--allow-env",
      "API_TOKEN",
      "--file",
      "SOURCE=/tmp/source.md",
      "--allow-net",
      "api.example.com",
      "--allow-collection",
      "notes",
    ]);
  });
});
