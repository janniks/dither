import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("daemon lifecycle (in-process)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-daemon-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(join(home, "entries"));
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("runDaemon writes pid + snapshot, exits cleanly on SIGTERM", async () => {
    const { runDaemon, readStatusSnapshot } = await import("./daemon");

    const exited = runDaemon();

    // Wait for pid file + snapshot.
    const pidPath = join(home, "dither.pid");
    const snapPath = join(home, "status.json");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(pidPath) && existsSync(snapPath)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(pidPath)).toBe(true);
    const snap = await readStatusSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.pid).toBe(process.pid);

    // Send SIGTERM to ourselves; the daemon registered a handler.
    process.kill(process.pid, "SIGTERM");
    await exited;
    expect(existsSync(pidPath)).toBe(false);
  }, 15_000);

  it("readDaemonPid returns null when no daemon is running", async () => {
    const { readDaemonPid } = await import("./daemon-control");
    expect(await readDaemonPid()).toBeNull();
  });

  it("getDaemonStatus reports not-running cleanly", async () => {
    const { getDaemonStatus } = await import("./daemon-control");
    const s = await getDaemonStatus();
    expect(s.running).toBe(false);
    expect(s.pid).toBeNull();
  });

  it("registers schedule from grants and fires runPlugin within ~3s", async () => {
    // Tiny inline plugin with `schedule: "every 1s"`.
    const pluginDir = mkdtempSync(join(tmpdir(), "dither-sched-fixture-"));
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "ticker",
        version: "0.0.1",
        dither: {
          schedule: "every 1s",
          collections: ["ticks"],
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "plugin.ts"),
      `import { writeEntry } from "@dither/plugin";\nawait writeEntry({ collection: "ticks", filename: "tick-" + Date.now() + ".md", body: "hi" });\n`,
    );

    const { installPlugin } = await import("./plugin-install");
    await installPlugin({ source: pluginDir });

    const { runDaemon } = await import("./daemon");
    const { listRuns } = await import("./journal");

    const exited = runDaemon();
    await new Promise((r) => setTimeout(r, 3500));
    process.kill(process.pid, "SIGTERM");
    await exited;

    const runs = await listRuns(50);
    const tickerRuns = runs.filter((r) => r.plugin === "ticker");
    expect(tickerRuns.length).toBeGreaterThanOrEqual(2);
    expect(tickerRuns.every((r) => r.status === "ok")).toBe(true);

    rmSync(pluginDir, { recursive: true, force: true });
  }, 30_000);
});

describe("daemon control (no daemon)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-daemon-spawn-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("stopDaemon is a clean no-op when nothing is running", async () => {
    const { stopDaemon } = await import("./daemon-control");
    const result = await stopDaemon(1000);
    expect(result.pid).toBeNull();
    expect(result.stopped).toBe(false);
  });
});
