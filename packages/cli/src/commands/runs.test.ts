import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";

describe("dither runs tail (single _result line)", () => {
  let home: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    prevDir = process.env.DITHER_DIR;
    home = mkdtempSync(join(tmpdir(), "dither-runs-tail-test-"));
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevDir;
  });

  it("emits exactly one _result line even when result.json reads slowly", async () => {
    const runId = "20250101T000000-fixture-abcd";
    const runDir = join(home, "history", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify({ runId, plugin: "fixture", trigger: "test", startedAt: new Date().toISOString() }),
    );
    // Events file present so followRun doesn't block on file-creation.
    writeFileSync(join(runDir, "events.jsonl"), "");

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    // Mock fs/promises so result.json reads take ~300ms — long enough
    // for the 100ms result-poll interval to fire 2-3 times mid-read.
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        default: actual,
        readFile: ((path: unknown, ...rest: unknown[]) => {
          if (typeof path === "string" && path.endsWith("result.json")) {
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                (actual.readFile as unknown as (...a: unknown[]) => Promise<unknown>)(
                  path,
                  ...rest,
                ).then(resolve, reject);
              }, 300);
            });
          }
          return (actual.readFile as unknown as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
        }) as unknown as typeof import("node:fs/promises").readFile,
      };
    });

    const { runsCommand } = await import("./runs");

    const cmdPromise = runCommand(runsCommand, { rawArgs: ["tail", runId] });

    // Let the command enter the poll loop, then drop result.json.
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      join(runDir, "result.json"),
      JSON.stringify({ status: "ok", finishedAt: new Date().toISOString(), promoted: [] }),
    );

    await cmdPromise;

    const resultLines = logs.filter((l) => l.includes('"type":"_result"'));
    expect(resultLines).toHaveLength(1);
  }, 10_000);
});
