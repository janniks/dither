import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";

async function captureLogs(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const outSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  const errSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  try {
    await fn();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out: logs.join("\n"), err: errs.join("\n") };
}

describe("dither collection", () => {
  let home: string;
  let library: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-collection-cli-"));
    library = realpathSync(mkdtempSync(join(home, "lib-")));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    const { saveConfig } = await import("../config");
    await saveConfig({
      schema: { version: 2 },
      library: { path: library },
      collections: { external: [] },
    });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("add registers an external with a slug defaulted from the basename", async () => {
    const ext = realpathSync(mkdtempSync(join(home, "Work Notes-")));
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "add", ext] });
    });
    const { loadConfig } = await import("../config");
    const cfg = await loadConfig();
    expect(cfg?.collections.external.length).toBe(1);
    expect(cfg?.collections.external[0]?.path).toBe(ext);
    // Slug derives from the mktemp basename ("Work Notes-XXXXXX") and
    // gets sanitised to lowercase with dashes. We don't pin the random
    // suffix — just assert it starts with our prefix slugified.
    expect(cfg?.collections.external[0]?.name).toMatch(/^work-notes-/);
  });

  it("add honors --name and rejects a colliding name", async () => {
    const a = realpathSync(mkdtempSync(join(home, "a-")));
    const b = realpathSync(mkdtempSync(join(home, "b-")));
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "add", a, "--name", "work"] });
    });
    await expect(
      captureLogs(async () => {
        await runCommand(main, { rawArgs: ["collection", "add", b, "--name", "work"] });
      }),
    ).rejects.toThrow(/external collection 'work'/);
  });

  it("add refuses a path inside the library", async () => {
    const inner = join(library, "inside");
    mkdirSync(inner);
    const { main } = await import("../main");
    await expect(
      captureLogs(async () => {
        await runCommand(main, { rawArgs: ["collection", "add", inner] });
      }),
    ).rejects.toThrow(/overlaps the library/);
  });

  it("list prints library subdirs and externals", async () => {
    mkdirSync(join(library, "notes"));
    const ext = realpathSync(mkdtempSync(join(home, "work-")));
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "add", ext, "--name", "work"] });
    });
    const { out } = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "list"] });
    });
    expect(out).toMatch(/notes\s+0 md\s+library/);
    expect(out).toMatch(/work\s+0 md\s+external/);
  });

  it("list --verbose adds path and md count and flags missing externals", async () => {
    const ext = realpathSync(mkdtempSync(join(home, "work-")));
    writeFileSync(join(ext, "a.md"), "# a", "utf-8");
    writeFileSync(join(ext, "b.md"), "# b", "utf-8");
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "add", ext, "--name", "work"] });
    });
    const okRun = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "list", "--verbose"] });
    });
    expect(okRun.out).toContain(ext);
    expect(okRun.out).toMatch(/work\s+2 md\s+external/);

    rmSync(ext, { recursive: true, force: true });
    const missingRun = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "list", "--verbose"] });
    });
    expect(missingRun.out).toContain("(missing)");
  });

  it("remove drops the registry entry without deleting files", async () => {
    const ext = realpathSync(mkdtempSync(join(home, "work-")));
    writeFileSync(join(ext, "keep.md"), "stays", "utf-8");
    const { main } = await import("../main");
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "add", ext, "--name", "work"] });
    });
    await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "remove", "work"] });
    });
    const { loadConfig } = await import("../config");
    expect((await loadConfig())?.collections.external).toEqual([]);
    expect(existsSync(join(ext, "keep.md"))).toBe(true);
    expect(readFileSync(join(ext, "keep.md"), "utf-8")).toBe("stays");
  });

  it("remove errors when targeting a library subdir", async () => {
    mkdirSync(join(library, "notes"));
    const { main } = await import("../main");
    await expect(
      captureLogs(async () => {
        await runCommand(main, { rawArgs: ["collection", "remove", "notes"] });
      }),
    ).rejects.toThrow(/library subdir/);
  });

  it("add defers the rescan via needs-reindex when qmd-index lock is held", async () => {
    // Seed a live-held index lock (our own pid) — as if the daemon is
    // mid-index. Registration must still succeed; the rescan defers.
    const { themeLockPath } = await import("../locks");
    const { needsReindexPath } = await import("../markers");
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(themeLockPath("index"), String(process.pid));

    const ext = realpathSync(mkdtempSync(join(home, "work-")));
    const { main } = await import("../main");
    const { out, err } = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["collection", "add", ext, "--name", "work"] });
    });
    const { loadConfig } = await import("../config");
    expect((await loadConfig())?.collections.external.length).toBe(1);
    expect(existsSync(needsReindexPath())).toBe(true);
    expect(err).toContain("busy");
    expect(out).toContain("registered 'work'");
  });

  it("remove errors when name isn't registered", async () => {
    const { main } = await import("../main");
    await expect(
      captureLogs(async () => {
        await runCommand(main, { rawArgs: ["collection", "remove", "ghost"] });
      }),
    ).rejects.toThrow(/no external collection/);
  });
});
