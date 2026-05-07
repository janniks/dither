import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("persistence", () => {
  let homeDir: string;
  let ditherHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "dither-persist-fakehome-"));
    ditherHome = mkdtempSync(join(tmpdir(), "dither-persist-dh-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = ditherHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(ditherHome, { recursive: true, force: true });
  });

  it("writes a unit file the first time and reports unchanged on the second", async () => {
    const { installAutostart, autostartPaths } = await import("./persistence");
    const { unitPath, platform } = autostartPaths(homeDir);

    if (!unitPath) {
      // Unsupported platform: just assert the no-op contract.
      const result = await installAutostart(homeDir);
      expect(result.written).toBe(false);
      expect(result.unitPath).toBeNull();
      return;
    }

    const first = await installAutostart(homeDir);
    expect(first.written).toBe(true);
    expect(first.unitPath).toBe(unitPath);
    expect(existsSync(unitPath)).toBe(true);

    const content = readFileSync(unitPath, "utf-8");
    if (platform === "darwin") {
      expect(content).toContain("dev.dither.daemon");
      expect(content).toContain(ditherHome);
      expect(content).toContain("<key>RunAtLoad</key><true/>");
    } else if (platform === "linux") {
      expect(content).toContain("[Service]");
      expect(content).toContain(`DITHER_HOME=${ditherHome}`);
    }

    const second = await installAutostart(homeDir);
    expect(second.written).toBe(false);
    expect(second.unchanged).toBe(true);
  });
});
