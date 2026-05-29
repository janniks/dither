import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
    vi.resetModules();
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  // Pretend `<plugin>` is already installed by laying down a minimal
  // plugin dir. Lets the run path skip "plugin not installed" without
  // wiring the full install flow.
  function fakeInstall(name: string): void {
    const dir = join(home, "plugins", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "0.0.0", dither: { manifest: {} } }),
    );
    writeFileSync(join(dir, "plugin.ts"), "// noop");
  }

  // Stand in for a live daemon: write a pid file pointing at this process
  // so `signalDaemon` has somewhere to send SIGUSR1. Also stub
  // `daemon-control` so the run path's auto-start short-circuits without
  // actually spawning a node child.
  function fakeDaemon(): void {
    writeFileSync(
      join(home, "dither.pid"),
      JSON.stringify({ pid: process.pid, token: "t", startedAt: "s" }),
    );
    vi.doMock("../daemon-control", async () => {
      const actual = await vi.importActual<typeof import("../daemon-control")>("../daemon-control");
      return {
        ...actual,
        readDaemonPid: async () => process.pid,
        startDaemon: async () => ({ pid: process.pid, alreadyRunning: true }),
      };
    });
  }

  it("`plugin run X --detach` writes a kick and exits without tailing", async () => {
    fakeInstall("watcher");
    fakeDaemon();
    const { main } = await import("../main");
    const logs = await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["plugin", "run", "watcher", "--detach"],
      });
    });

    expect(existsSync(join(home, "kicks", "watcher.json"))).toBe(true);
    expect(logs).toMatch(/kicked watcher/);
    // The kick payload should carry the runId the CLI printed.
    const blob = JSON.parse(
      require("node:fs").readFileSync(join(home, "kicks", "watcher.json"), "utf-8"),
    ) as { runId: string };
    expect(logs).toContain(blob.runId);
  });

  it("`plugin run X --detach` layers per-run overrides into the kick payload", async () => {
    fakeInstall("watcher");
    fakeDaemon();
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: [
          "plugin",
          "run",
          "watcher",
          "--detach",
          "--env",
          "TOKEN=abc",
          "--allow-net",
          "api.example.com",
        ],
      });
    });
    const blob = JSON.parse(
      require("node:fs").readFileSync(join(home, "kicks", "watcher.json"), "utf-8"),
    ) as { overrides?: { env?: Record<string, string>; net?: string[] } };
    expect(blob.overrides?.env).toEqual({ TOKEN: "abc" });
    expect(blob.overrides?.net).toEqual(["api.example.com"]);
  });

  it("`plugin run X` rejects when a kick is already pending", async () => {
    fakeInstall("watcher");
    fakeDaemon();
    mkdirSync(join(home, "kicks"), { recursive: true });
    writeFileSync(
      join(home, "kicks", "watcher.json"),
      JSON.stringify({ runId: "preexisting", kickedAt: "t" }),
    );

    const { main } = await import("../main");
    const errs: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errs.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    try {
      await expect(
        captureLogs(async () => {
          await runCommand(main, { rawArgs: ["plugin", "run", "watcher"] });
        }),
      ).rejects.toThrow(/exit:1/);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(errs.join("")).toMatch(/already running/);
  });
});
