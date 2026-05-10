import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { _resetHomeWarningLatch } from "../home";

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

describe("dither status (output shape)", () => {
  let home: string;
  let prevDir: string | undefined;
  let prevXdg: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevDir = process.env.DITHER_DIR;
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevHome = process.env.DITHER_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.DITHER_HOME;
    home = mkdtempSync(join(tmpdir(), "dither-status-cmd-test-"));
    process.env.DITHER_DIR = home;
    _resetHomeWarningLatch();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevDir;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHome === undefined) delete process.env.DITHER_HOME;
    else process.env.DITHER_HOME = prevHome;
  });

  it("emits the DITHER_DIR header line when env is the source", async () => {
    const lib = join(home, "library");
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
    );
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status"] });
    });
    expect(out).toContain(`DITHER_DIR=${home}`);
  });

  it("does NOT emit a header line when env is not the source", async () => {
    delete process.env.DITHER_DIR;
    process.env.XDG_CONFIG_HOME = home;
    // No config exists yet at the resolved path; that's fine — just
    // checking the header path / non-header path.
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status"] });
    });
    expect(out).not.toContain("DITHER_DIR=");
  });

  it("renders three blank-line-separated sections", async () => {
    const lib = join(home, "library");
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
    );
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status"] });
    });
    // Two blank lines after the env header + two between sections.
    expect(out.split("\n\n").length).toBeGreaterThanOrEqual(4);
    expect(out).toContain("config dir:");
    expect(out).toContain("library:");
    expect(out).toContain("plugins:");
    expect(out).toContain("daemon:");
  });

  it("does not include any source-attribution parentheticals", async () => {
    const lib = join(home, "library");
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
    );
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status"] });
    });
    expect(out).not.toContain("(env: DITHER_DIR)");
    expect(out).not.toContain("(config: library.path");
  });

  it("flags missing library with ⚠ glyph and — counts", async () => {
    const ghost = join(tmpdir(), "dither-ghost-library-zzz");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: ghost } }),
    );
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status"] });
    });
    expect(out).toContain("⚠ missing");
    expect(out).toContain("collections: —");
    expect(out).toContain("entries:     —");
    expect(out).toContain("(library missing)");
  });

  it("flags unreadable library with ⚠ glyph and — counts", async () => {
    const lib = mkdtempSync(join(tmpdir(), "dither-unreadable-cmd-"));
    chmodSync(lib, 0o000);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
    );
    try {
      const { main } = await import("../main");
      const out = await captureLogs(async () => {
        await runCommand(main, { rawArgs: ["status"] });
      });
      expect(out).toContain("⚠ unreadable");
      expect(out).toContain("entries:     —");
    } finally {
      chmodSync(lib, 0o700);
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it("shows '(not configured — run `dither init`)' before init", async () => {
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status"] });
    });
    expect(out).toContain("(not configured — run `dither init`)");
  });

  it("formats counts with comma-thousands separators", async () => {
    const lib = join(home, "library");
    const collection = join(lib, "notes");
    mkdirSync(collection, { recursive: true });
    // Create 1234 markdown files to force a comma.
    for (let i = 0; i < 1234; i++) {
      writeFileSync(join(collection, `entry-${i}.md`), "# x");
    }
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
    );
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status"] });
    });
    expect(out).toMatch(/entries:\s+1,234/);
  });

  it("--json emits one JSON value with libraryHealth + configDirSource", async () => {
    const lib = join(home, "library");
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: lib } }),
    );
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status", "--json"] });
    });
    const parsed = JSON.parse(out);
    expect(parsed.libraryHealth).toBe("ok");
    expect(parsed.configDirSource).toBe("env");
    expect(parsed.configDir).toBe(home);
    expect(parsed.library).toBe(lib);
    // Deprecated `home` alias retained.
    expect(parsed.home).toBe(home);
  });

  it("--json contains no ANSI escape sequences", async () => {
    const { main } = await import("../main");
    const out = await captureLogs(async () => {
      await runCommand(main, { rawArgs: ["status", "--json"] });
    });
    // ANSI escape: \x1b[ followed by codes ending with a letter.
    expect(out).not.toMatch(/\x1b\[/);
  });
});
