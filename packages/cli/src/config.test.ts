import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config module", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-config-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("loadConfig returns null when no config file exists", async () => {
    const { loadConfig } = await import("./config");
    expect(await loadConfig()).toBeNull();
  });

  it("saveConfig + loadConfig round-trips a valid config", async () => {
    const { saveConfig, loadConfig } = await import("./config");
    const cfg = {
      schema: { version: 2 },
      library: { path: join(home, "library") },
      collections: { external: [] },
    };
    await saveConfig(cfg);
    const loaded = await loadConfig();
    expect(loaded).toEqual(cfg);
  });

  it("loadConfig accepts v1 configs and normalises them to v2 with empty externals", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 1 }, library: { path: "/tmp/x" } }),
      "utf-8",
    );
    const { loadConfig } = await import("./config");
    const loaded = await loadConfig();
    expect(loaded).toEqual({
      schema: { version: 2 },
      library: { path: "/tmp/x" },
      collections: { external: [] },
    });
  });

  it("loadConfig round-trips a v2 config with externals", async () => {
    const { saveConfig, loadConfig } = await import("./config");
    const cfg = {
      schema: { version: 2 },
      library: { path: join(home, "library") },
      collections: {
        external: [
          { name: "work", path: "/tmp/work" },
          { name: "personal", path: "/tmp/personal" },
        ],
      },
    };
    await saveConfig(cfg);
    expect(await loadConfig()).toEqual(cfg);
  });

  it("loadConfig tolerates // line comments and /* */ block comments", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      `// header comment\n{\n  "schema": { "version": 2 }, /* inline */\n  "library": { "path": "/tmp/x" } // trailing\n}\n`,
      "utf-8",
    );
    const { loadConfig } = await import("./config");
    const loaded = await loadConfig();
    expect(loaded).toEqual({
      schema: { version: 2 },
      library: { path: "/tmp/x" },
      collections: { external: [] },
    });
  });

  it("loadConfig rejects malformed JSON with a typed error mentioning the path", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), "{ this is not json", "utf-8");
    const { loadConfig } = await import("./config");
    await expect(loadConfig()).rejects.toThrow(/config at .*config\.json is malformed/);
  });

  it("loadConfig rejects schema-version mismatch", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ schema: { version: 99 }, library: { path: "/x" } }),
      "utf-8",
    );
    const { loadConfig } = await import("./config");
    await expect(loadConfig()).rejects.toThrow(/schema\.version=99/);
  });

  it("loadConfig rejects missing library.path", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ schema: { version: 2 } }), "utf-8");
    const { loadConfig } = await import("./config");
    await expect(loadConfig()).rejects.toThrow(/library\.path/);
  });

  it("loadConfig rejects malformed collections.external entries", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        schema: { version: 2 },
        library: { path: "/x" },
        collections: { external: [{ name: "ok" }] },
      }),
      "utf-8",
    );
    const { loadConfig } = await import("./config");
    await expect(loadConfig()).rejects.toThrow(/malformed collections\.external/);
  });

  it("assertInitialized throws NotInitializedError when no config exists", async () => {
    const { assertInitialized, NotInitializedError } = await import("./config");
    await expect(assertInitialized()).rejects.toBeInstanceOf(NotInitializedError);
  });

  it("assertInitialized returns the config when present", async () => {
    const { saveConfig, assertInitialized } = await import("./config");
    const cfg = {
      schema: { version: 2 },
      library: { path: join(home, "library") },
      collections: { external: [] },
    };
    await saveConfig(cfg);
    const got = await assertInitialized();
    expect(got).toEqual(cfg);
  });
});
