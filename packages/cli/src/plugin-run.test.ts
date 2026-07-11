import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Phase 2 — plugin run = transaction (state atomicity).
 *
 * The plugin's state is staged in `runs/<runId>/state.json`, seeded from
 * the committed `<pluginDir>/state/state.json`, and only commits (atomic
 * tmp+rename) on a clean finish, alongside promotion. An interrupted run
 * leaves committed state untouched and nothing promoted.
 *
 * We inject a fake spawn so the real seed/repoint/commit/rollback code in
 * `runPluginLocked` runs without a Deno binary. The fake child reads
 * `DITHER_STATE_FILE` / `DITHER_RUN_DIR` from the spawn env (exactly what a
 * real plugin sees) and performs the plugin's filesystem effects.
 */

interface PluginAct {
  /** Number to write into the run-local state file's `n` field. */
  state?: number;
  /** When set, write an output entry `<runDir>/out.md` for promotion. */
  emitEntry?: boolean;
  /** Exit code the child reports. Non-zero → failure path. */
  exit: number;
}

function fakeSpawn(act: PluginAct) {
  const seen: { stateBefore: unknown } = { stateBefore: undefined };
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
    pid: number;
  };
  child.stderr = new PassThrough();
  child.pid = 4242;
  const spawn = ((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
    const stateFile = opts.env.DITHER_STATE_FILE!;
    const runDir = opts.env.DITHER_RUN_DIR!;
    // Mirror a plugin: read the run-local state it was seeded with…
    seen.stateBefore = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, "utf-8"))
      : null;
    setImmediate(() => {
      // …mutate state (within the runDir write grant)…
      if (act.state !== undefined) {
        writeFileSync(stateFile, JSON.stringify({ n: act.state }));
      }
      // …optionally stage an output entry.
      if (act.emitEntry) {
        writeFileSync(
          join(runDir, "out.md"),
          `---\nsource: statey\ncollection: notes\n---\n\nhi\n`,
        );
      }
      child.stderr.end();
      child.emit("close", act.exit);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, seen };
}

describe("runPlugin — state is transactional", () => {
  let home: string;
  let prev: string | undefined;
  let libraryPath: string;
  const plugin = "statey";

  function pluginDir() {
    return join(home, "plugins", plugin);
  }
  function committedState() {
    return join(pluginDir(), "state", "state.json");
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-pluginrun-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    libraryPath = join(home, "library");
    mkdirSync(libraryPath, { recursive: true });
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(libraryPath);

    // Minimal installed plugin + grant for the `notes` collection.
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(
      join(pluginDir(), "package.json"),
      JSON.stringify({
        name: plugin,
        version: "0.0.1",
        dither: { display_name: "Statey", create: ["notes"] },
      }),
    );
    mkdirSync(join(home, "grants"), { recursive: true });
    writeFileSync(
      join(home, "grants", `${plugin}.json`),
      JSON.stringify({ create: ["notes"] }),
    );
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("commits state atomically on a clean finish; the next run reads it back", async () => {
    const { runPlugin } = await import("./plugin-run");

    // First clean run writes state n=1 and an entry.
    const f1 = fakeSpawn({ state: 1, emitEntry: true, exit: 0 });
    const r1 = await runPlugin({ name: plugin, spawn: f1.spawn });
    // Seeded run-local state was absent (no committed state yet).
    expect(f1.seen.stateBefore).toBeNull();
    expect(r1.added).toHaveLength(1);
    // Committed state reflects the write.
    expect(existsSync(committedState())).toBe(true);
    expect(JSON.parse(readFileSync(committedState(), "utf-8"))).toEqual({ n: 1 });
    // Output promoted into the library.
    expect(existsSync(join(libraryPath, "notes", "out.md"))).toBe(true);

    // Second clean run is seeded from the committed state, then advances it.
    const f2 = fakeSpawn({ state: 2, exit: 0 });
    await runPlugin({ name: plugin, spawn: f2.spawn });
    expect(f2.seen.stateBefore).toEqual({ n: 1 });
    expect(JSON.parse(readFileSync(committedState(), "utf-8"))).toEqual({ n: 2 });
  });

  it("rolls back state and promotes nothing when the run fails after writing state", async () => {
    const { runPlugin } = await import("./plugin-run");

    // Seed a committed state n=7 via a clean run.
    await runPlugin({ name: plugin, spawn: fakeSpawn({ state: 7, exit: 0 }).spawn });
    expect(JSON.parse(readFileSync(committedState(), "utf-8"))).toEqual({ n: 7 });

    // A run that writes run-local state n=999 and an entry, then exits non-zero.
    const f = fakeSpawn({ state: 999, emitEntry: true, exit: 1 });
    await expect(runPlugin({ name: plugin, spawn: f.spawn })).rejects.toThrow();

    // Committed state is unchanged — the mutated run-local copy was discarded.
    expect(JSON.parse(readFileSync(committedState(), "utf-8"))).toEqual({ n: 7 });
    // Nothing promoted.
    expect(existsSync(join(libraryPath, "notes", "out.md"))).toBe(false);
  });

  it("grants the plugin write to the run dir only, not the persistent state dir", async () => {
    const { runPlugin } = await import("./plugin-run");
    let writeArg: string | undefined;
    const spawn = ((_cmd: string, args: string[]) => {
      writeArg = args.find((a) => a.startsWith("--allow-write="));
      const child = new EventEmitter() as EventEmitter & { stderr: PassThrough; pid: number };
      child.stderr = new PassThrough();
      child.pid = 1;
      setImmediate(() => {
        child.stderr.end();
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    await runPlugin({ name: plugin, spawn });
    expect(writeArg).toBeDefined();
    expect(writeArg).toContain(join(home, "runs"));
    expect(writeArg).not.toContain(join(pluginDir(), "state"));
  });
});

describe("plan — the pure spawn plan", () => {
  const base = {
    name: "p",
    trigger: "manual",
    pluginDir: "/plugins/p",
    runDir: "/runs/r1",
    sdkPath: "/sdk/index.ts",
    importMapPath: "/runs/r1/_import-map.json",
    inputFile: "/runs/r1/input.json",
    stateFile: "/runs/r1/state.json",
    resolvedEnv: {},
    grantFiles: {},
    grantNet: [],
    watchRoots: [],
    targets: [],
  };

  it("rejects permission entries containing a comma", async () => {
    const { plan } = await import("./plugin-run");
    expect(() => plan({ ...base, grantFiles: { bad: "/a,b" } })).toThrow(/comma/);
    expect(() => plan({ ...base, grantNet: ["a.example.com,b.example.com"] })).toThrow(/comma/);
  });

  it("watch roots replace per-target read grants (ARG_MAX fallback)", async () => {
    const { plan } = await import("./plugin-run");
    const targets = [{ path: "/lib/notes/a.md", mtime: "2026-01-01T00:00:00Z" }];
    const withRoots = plan({ ...base, watchRoots: ["/lib/notes"], targets });
    const read = withRoots.denoArgs.find((a) => a.startsWith("--allow-read="))!;
    expect(read).toContain("/lib/notes");
    expect(read).not.toContain("/lib/notes/a.md");
    // No roots → explicit-target callers still get per-target grants.
    const without = plan({ ...base, targets });
    expect(without.denoArgs.find((a) => a.startsWith("--allow-read="))).toContain("/lib/notes/a.md");
  });

  it("net ['*'] becomes bare --allow-net; named hosts stay scoped", async () => {
    const { plan } = await import("./plugin-run");
    expect(plan({ ...base, grantNet: ["*"] }).denoArgs).toContain("--allow-net");
    const scoped = plan({ ...base, grantNet: ["api.example.com"] }).denoArgs;
    expect(scoped).toContain("--allow-net=api.example.com");
    expect(scoped).not.toContain("--allow-net");
  });

  it("--allow-env is derived from the DITHER_* env record — one source", async () => {
    const { plan } = await import("./plugin-run");
    const p = plan(base);
    const allow = p.denoArgs.find((a) => a.startsWith("--allow-env="))!;
    const names = allow.slice("--allow-env=".length).split(",");
    // Every allow-listed name is set in the child env (they're the same
    // record, so they can't diverge). The ambient process.env may carry
    // other DITHER_ vars (e.g. DITHER_USE_SYSTEM_DENO) — not allow-listed.
    for (const n of names) expect(p.env[n]).toBeDefined();
    expect(names.sort()).toEqual([
      "DITHER_INPUT_FILE",
      "DITHER_PLUGIN_NAME",
      "DITHER_RUN_DIR",
      "DITHER_STATE_FILE",
      "DITHER_TRIGGER",
    ]);
  });
});
