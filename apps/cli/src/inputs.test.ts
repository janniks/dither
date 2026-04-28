import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ECHO_FIXTURE = resolve(__dirname, "..", "test", "fixtures", "echo-config");
const READ_FILE_FIXTURE = resolve(__dirname, "..", "test", "fixtures", "read-file");

describe("plugin inputs flow (config + secrets)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-inputs-test-"));
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

  it("delivers user-provided config and secret values to a plugin via readInput()", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { runPlugin } = await import("./plugin-run");

    await installPlugin({
      source: ECHO_FIXTURE,
      inputs: {
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
    // Defaulted number input should round-trip with its declared default value.
    expect(content).toContain("Max runs: 3");
  }, 60000);

  it("rejects install when a required input has no value and no default", async () => {
    const { installPlugin } = await import("./plugin-install");

    await expect(
      installPlugin({
        source: ECHO_FIXTURE,
        inputs: { GREETING: "hi" /* API_TOKEN missing */ },
      }),
    ).rejects.toThrow(/API_TOKEN/);
  });

  it("delivers a file input path and lets the plugin read its contents", async () => {
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
});
