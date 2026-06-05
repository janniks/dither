import { describe, it, expect, vi, afterEach } from "vitest";

// Drives the `daemon status` renderer with a stubbed status so we can assert
// the running build stamp is surfaced. getDaemonStatus is mocked; the renderer
// pulls the stamp from snapshot.version (set by writeStatusSnapshot).
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function snapshot(version: string) {
  return {
    pid: 4242,
    token: "tok",
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    version,
    schedules: 0,
    watches: 0,
    running: [],
    recentRuns: [],
    recentHalts: [],
    scheduleEntries: [],
    watchEntries: [],
  };
}

describe("daemon status rendering", () => {
  it("shows the running build stamp", async () => {
    vi.doMock("../daemon-control", async (orig) => ({
      ...(await orig<typeof import("../daemon-control")>()),
      getDaemonStatus: async () => ({
        running: true,
        pid: 4242,
        home: "/tmp/home",
        snapshot: snapshot("0.0.1+abc1234.20260101000000"),
        reason: null,
      }),
    }));

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));

    const { daemonCommand } = await import("./command-daemon");
    const subs = (await daemonCommand.subCommands) as Record<string, { run(c: never): Promise<void> }>;
    await subs["status"]!.run({ args: { json: false, _: [] } } as never);

    expect(lines.some((l) => l.includes("build:") && l.includes("0.0.1+abc1234.20260101000000"))).toBe(true);
  });
});
