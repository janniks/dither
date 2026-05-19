import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { embedDisabledPath, needsReindexPath } from "../daemon-jobs";
import { qmdLockPath } from "../qmd-locks";

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
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

describe("dither index commands", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-index-cmd-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe("dither index cancel", () => {
    it("prints 'nothing to cancel' when no qmd job is running", async () => {
      // Need a config to pass assertInitialized.
      mkdirSync(join(home), { recursive: true });
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          schema: { version: 2 },
          library: { path: home },
          collections: { external: [] },
        }),
        "utf-8",
      );
      const { main } = await import("../main");
      const out = await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["index", "cancel"] });
      });
      expect(out).toContain("nothing to cancel");
    });

    it("writes embed-disabled marker when cancelling an active embed lock", async () => {
      // Set up config + fake lock file pointing at our own PID so
      // isPidAlive() returns true and qmd-locks treats the lock as
      // active. Stub process.kill so cancel doesn't actually SIGTERM
      // the test runner.
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          schema: { version: 2 },
          library: { path: home },
          collections: { external: [] },
        }),
        "utf-8",
      );
      mkdirSync(join(home, "locks"), { recursive: true });
      writeFileSync(qmdLockPath("embed"), String(process.pid), "utf-8");

      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number) => {
        // Probe (signal === 0) must still return true.
        if (signal === 0) return true;
        if (signal === "SIGTERM" || signal === 15) {
          // Simulate the holder cleaning up its lock on SIGTERM so the
          // wait-for-release path exits promptly instead of timing out.
          try {
            unlinkSync(qmdLockPath("embed"));
          } catch {
            // Already gone.
          }
          return true;
        }
        return true;
      });

      try {
        const { main } = await import("../main");
        const out = await captureLogs(async () => {
          await runCommand(main, { rawArgs: ["index", "cancel"] });
        });
        // Embed-disabled marker MUST be written before SIGTERM so the
        // daemon's post-cancel reconcile doesn't immediately re-queue.
        expect(existsSync(embedDisabledPath())).toBe(true);
        expect(out).toMatch(/cancelled embed/);
        expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  describe("dither index update", () => {
    it("clears embed-disabled marker and reports the inline reindex result", async () => {
      // Set up config + library + embed-disabled marker.
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          schema: { version: 2 },
          library: { path: home },
          collections: { external: [] },
        }),
        "utf-8",
      );
      mkdirSync(join(home, "notes"), { recursive: true });
      writeFileSync(join(home, "notes", "memo.md"), "# Memo\n\nHello.\n", "utf-8");
      writeFileSync(embedDisabledPath(), "", "utf-8");
      expect(existsSync(embedDisabledPath())).toBe(true);

      const { main } = await import("../main");
      const out = await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["index", "update"] });
      });
      expect(existsSync(embedDisabledPath())).toBe(false);
      expect(out).toContain("index updated:");
    });

    it("touches needs-reindex marker only when a daemon is running (test-mode no-op)", async () => {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          schema: { version: 2 },
          library: { path: home },
          collections: { external: [] },
        }),
        "utf-8",
      );
      mkdirSync(join(home, "notes"), { recursive: true });
      writeFileSync(join(home, "notes", "memo.md"), "# Memo\n\nHello.\n", "utf-8");

      const { main } = await import("../main");
      await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["index", "update"] });
      });
      // No daemon in tests → no marker touched, no SIGHUP attempted.
      expect(existsSync(needsReindexPath())).toBe(false);
    });
  });
});
