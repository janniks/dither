import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("listPlugins reads schedule from grants top-level (not manifest)", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-plugin-list-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    mkdirSync(join(home, "grants"), { recursive: true });
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  function writeGrants(name: string, body: object): void {
    writeFileSync(join(home, "grants", `${name}.json`), JSON.stringify(body));
  }

  it("reports schedule when grants.schedule is set, ignoring manifest.schedule", async () => {
    writeGrants("a", {
      version: "1.0.0",
      schedule: "*/5 * * * *",
      manifest: { schedule: "*/15 * * * *" },
    });
    const { listPlugins } = await import("./plugin-list");
    const list = await listPlugins();
    expect(list.find((p) => p.name === "a")?.schedule).toBe("*/5 * * * *");
  });

  it("omits schedule when grants.schedule is null even if manifest declares one", async () => {
    writeGrants("b", {
      version: "1.0.0",
      schedule: null,
      manifest: { schedule: "*/15 * * * *" },
    });
    const { listPlugins } = await import("./plugin-list");
    const list = await listPlugins();
    expect(list.find((p) => p.name === "b")?.schedule).toBeUndefined();
  });

  it("omits schedule when legacy grants file has no top-level field", async () => {
    writeGrants("c", { version: "1.0.0", manifest: { schedule: "*/15 * * * *" } });
    const { listPlugins } = await import("./plugin-list");
    const list = await listPlugins();
    expect(list.find((p) => p.name === "c")?.schedule).toBeUndefined();
  });
});
