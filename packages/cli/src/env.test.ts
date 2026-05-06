import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ECHO_FIXTURE = resolve(__dirname, "..", "test", "fixtures", "echo-config");
const READ_FILE_FIXTURE = resolve(__dirname, "..", "test", "fixtures", "read-file");

describe("plugin env flow", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-env-test-"));
    prevHome = process.env.DITHER_HOME;
    process.env.DITHER_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.DITHER_HOME;
    } else {
      process.env.DITHER_HOME = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("delivers user-provided env values to a plugin via readInput()", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({
      source: ECHO_FIXTURE,
      env: {
        GREETING: "hello world",
        API_TOKEN: "tok-deadbeef",
      },
    });

    await runPlugin({ name: "echo-config" });

    const entriesDir = join(home, "entries", "echoed");
    const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    const content = readFileSync(join(entriesDir, files[0]!), "utf-8");
    expect(content).toContain("Greeting: hello world");
    expect(content).toContain("Token: tok-deadbeef");
    expect(content).toContain("Max runs: 3");
  }, 60000);

  it("rejects install when a required env has no value and no default", async () => {
    const { installPlugin } = await import("./plugin-install");

    await expect(
      installPlugin({
        source: ECHO_FIXTURE,
        env: { GREETING: "hi" /* API_TOKEN missing */ },
      }),
    ).rejects.toThrow(/API_TOKEN/);
  });

  it("resolves env from the global store when --allow-env is passed", async () => {
    const { setGlobalEnv } = await import("./global-env");
    await setGlobalEnv("API_TOKEN", "from-global");

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({
      source: ECHO_FIXTURE,
      env: { GREETING: "hi" },
      envRefs: ["API_TOKEN"],
    });

    await runPlugin({ name: "echo-config" });

    const dest = join(home, "entries", "echoed");
    const files = readdirSync(dest).filter((f) => f.endsWith(".md"));
    const content = readFileSync(join(dest, files[0]!), "utf-8");
    expect(content).toContain("Token: from-global");
  }, 60000);

  it("rotating a global env value propagates to the next run without reinstall", async () => {
    const { setGlobalEnv } = await import("./global-env");
    await setGlobalEnv("API_TOKEN", "first");

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({
      source: ECHO_FIXTURE,
      env: { GREETING: "hi" },
      envRefs: ["API_TOKEN"],
    });
    await runPlugin({ name: "echo-config" });

    await setGlobalEnv("API_TOKEN", "second");
    await runPlugin({ name: "echo-config" });

    // Each run produces a distinct UUID-named entry. Concatenate all entry
    // bodies and assert the rotated value made it through on at least one
    // run (the second).
    const dest = join(home, "entries", "echoed");
    const files = readdirSync(dest).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(2);
    const blob = files.map((f) => readFileSync(join(dest, f), "utf-8")).join("\n");
    expect(blob).toContain("Token: first");
    expect(blob).toContain("Token: second");
  }, 60000);

  it("delivers a file path and lets the plugin read its contents via the SDK helper", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "dither-source-"));
    const sourceFile = join(sourceDir, "snippet.md");
    writeFileSync(sourceFile, "Loaded from disk via input.files. Sentinel: salamander.");

    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({
      source: READ_FILE_FIXTURE,
      files: { SOURCE: sourceFile },
    });

    await runPlugin({ name: "read-file" });

    const dest = join(home, "entries", "read");
    const files = readdirSync(dest).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    const content = readFileSync(join(dest, files[0]!), "utf-8");
    expect(content).toContain("Sentinel: salamander");

    rmSync(sourceDir, { recursive: true, force: true });
  }, 60000);

  it("rejects install when a required file is not provided", async () => {
    const { installPlugin } = await import("./plugin-install");

    await expect(
      installPlugin({
        source: READ_FILE_FIXTURE,
        // SOURCE file missing
      }),
    ).rejects.toThrow(/SOURCE/);
  });

  it("rejects install when a provided file path does not exist", async () => {
    const { installPlugin } = await import("./plugin-install");

    await expect(
      installPlugin({
        source: READ_FILE_FIXTURE,
        files: { SOURCE: "/definitely/not/here.md" },
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("canonicalises a symlinked file grant to the real path at install time", async () => {
    const { symlinkSync, realpathSync } = await import("node:fs");

    const sourceDir = mkdtempSync(join(tmpdir(), "dither-symlink-src-"));
    const realFile = realpathSync(join(sourceDir, "real.md").replace(/real\.md$/, "")) + "real.md";
    writeFileSync(realFile, "real contents");
    const linkFile = join(sourceDir, "link.md");
    symlinkSync(realFile, linkFile);

    const { installPlugin } = await import("./plugin-install");
    await installPlugin({
      source: READ_FILE_FIXTURE,
      files: { SOURCE: linkFile },
    });

    // Grants file stores the realpath, not the symlink path — replacing
    // the symlink later cannot silently widen the plugin's access.
    const grantsRaw = readFileSync(join(home, "grants", "read-file.json"), "utf-8");
    const grants = JSON.parse(grantsRaw) as { files: Record<string, string> };
    expect(grants.files.SOURCE).toBe(realFile);
    expect(grants.files.SOURCE).not.toBe(linkFile);

    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("per-run env override does not mutate persisted grants", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({
      source: ECHO_FIXTURE,
      env: { GREETING: "from install", API_TOKEN: "tok-installed" },
    });

    await runPlugin({
      name: "echo-config",
      env: { GREETING: "from run" },
    });

    // The latest run-1 entry should reflect the override.
    const dest = join(home, "entries", "echoed");
    const files = readdirSync(dest).filter((f) => f.endsWith(".md"));
    const content = readFileSync(join(dest, files[0]!), "utf-8");
    expect(content).toContain("Greeting: from run");
    expect(content).toContain("Token: tok-installed");

    // Grants on disk must still hold the install-time value.
    const grants = JSON.parse(readFileSync(join(home, "grants", "echo-config.json"), "utf-8")) as {
      env: Record<string, string>;
    };
    expect(grants.env.GREETING).toBe("from install");
  }, 60000);
});
