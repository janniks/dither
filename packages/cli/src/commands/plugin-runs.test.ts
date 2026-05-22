import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";

function writeRun(
  home: string,
  runId: string,
  plugin: string,
  result: object | null,
): void {
  const dir = join(home, "history", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ runId, plugin, trigger: "test", startedAt: "2026-05-22T10:00:00Z" }),
  );
  writeFileSync(join(dir, "events.jsonl"), "");
  if (result) writeFileSync(join(dir, "result.json"), JSON.stringify(result));
}

describe("dither plugin runs", () => {
  let home: string;
  let prev: string | undefined;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    vi.resetModules();
    prev = process.env.DITHER_DIR;
    home = mkdtempSync(join(tmpdir(), "dither-plugin-runs-test-"));
    process.env.DITHER_DIR = home;
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errs.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
  });

  it("with no arg lists recent runs", async () => {
    writeRun(home, "20260522T100000-foo-aaaaaaaa", "foo", {
      status: "ok",
      finishedAt: "2026-05-22T10:00:01Z",
      added: ["/x.md"],
    });
    writeRun(home, "20260522T100100-bar-bbbbbbbb", "bar", {
      status: "ok",
      finishedAt: "2026-05-22T10:01:01Z",
      added: [],
    });

    const { pluginCommand } = await import("./plugin");
    await runCommand(pluginCommand, { rawArgs: ["runs"] });

    const out = logs.join("\n");
    expect(out).toContain("20260522T100000-foo-aaaaaaaa");
    expect(out).toContain("20260522T100100-bar-bbbbbbbb");
    expect(out).toMatch(/1 added/);
    expect(out).toMatch(/0 added/);
  });

  it("with no arg + empty history prints the hint", async () => {
    const { pluginCommand } = await import("./plugin");
    await runCommand(pluginCommand, { rawArgs: ["runs"] });
    expect(logs.join("\n")).toContain("No runs yet");
  });

  it("with a runid tails that run and emits _result", async () => {
    const runId = "20260522T100000-foo-aaaaaaaa";
    writeRun(home, runId, "foo", {
      status: "ok",
      finishedAt: "2026-05-22T10:00:01Z",
      added: ["/x.md"],
    });

    const { pluginCommand } = await import("./plugin");
    await runCommand(pluginCommand, { rawArgs: ["runs", runId] });

    const resultLines = logs.filter((l) => l.includes('"type":"_result"'));
    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]).toContain('"added":["/x.md"]');
  });

  it("with a plugin name resolves to the newest matching run", async () => {
    writeRun(home, "20260522T100000-foo-aaaaaaaa", "foo", {
      status: "ok",
      finishedAt: "2026-05-22T10:00:01Z",
      added: ["/old.md"],
    });
    writeRun(home, "20260522T110000-foo-cccccccc", "foo", {
      status: "ok",
      finishedAt: "2026-05-22T11:00:01Z",
      added: ["/new.md"],
    });
    writeRun(home, "20260522T120000-bar-bbbbbbbb", "bar", {
      status: "ok",
      finishedAt: "2026-05-22T12:00:01Z",
      added: ["/other.md"],
    });

    const { pluginCommand } = await import("./plugin");
    await runCommand(pluginCommand, { rawArgs: ["runs", "foo"] });

    const resultLines = logs.filter((l) => l.includes('"type":"_result"'));
    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]).toContain('"/new.md"');
    expect(resultLines[0]).not.toContain('"/old.md"');
  });

  it("with a plugin name that has zero runs errors and exits 1", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { pluginCommand } = await import("./plugin");
    await runCommand(pluginCommand, { rawArgs: ["runs", "nonexistent"] }).catch(
      () => undefined,
    );
    expect(errs.join("")).toContain("no runs yet for 'nonexistent'");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("with a runid-shaped target that doesn't exist errors and exits 1", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { pluginCommand } = await import("./plugin");
    await runCommand(pluginCommand, {
      rawArgs: ["runs", "20260522T100000-ghost-ffffffff"],
    }).catch(() => undefined);
    expect(errs.join("")).toContain("no run found with id 20260522T100000-ghost-ffffffff");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("emits exactly one _result line even when result.json reads slowly", async () => {
    const runId = "20260522T100000-fixture-abcd1234";
    const runDir = join(home, "history", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify({ runId, plugin: "fixture", trigger: "test", startedAt: new Date().toISOString() }),
    );
    writeFileSync(join(runDir, "events.jsonl"), "");

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

    const { pluginCommand } = await import("./plugin");
    const cmdPromise = runCommand(pluginCommand, { rawArgs: ["runs", runId] });

    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      join(runDir, "result.json"),
      JSON.stringify({ status: "ok", finishedAt: new Date().toISOString(), added: [] }),
    );

    await cmdPromise;

    const resultLines = logs.filter((l) => l.includes('"type":"_result"'));
    expect(resultLines).toHaveLength(1);
  }, 10_000);
});
