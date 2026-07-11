import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("grants file layer", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-grants-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    mkdirSync(join(home, "grants"), { recursive: true });
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  function seed(name: string, body: object): void {
    writeFileSync(join(home, "grants", `${name}.json`), JSON.stringify(body));
  }

  it("readGrants returns null on missing, throws on corrupt", async () => {
    const { readGrants } = await import("./grants");
    expect(await readGrants("nope")).toBeNull();
    writeFileSync(join(home, "grants", "bad.json"), "{not json");
    await expect(readGrants("bad")).rejects.toThrow();
  });

  it("readGrants normalizes create/edit/net and defaults name from filename", async () => {
    seed("a", { version: "1.0.0" });
    const { readGrants } = await import("./grants");
    const g = await readGrants("a");
    expect(g?.name).toBe("a");
    expect(g?.create).toEqual([]);
    expect(g?.edit).toEqual([]);
    expect(g?.net).toEqual([]);
  });

  it("schedule comes from grants top-level, ignoring manifest.schedule", async () => {
    seed("a", {
      version: "1.0.0",
      schedule: "*/5 * * * *",
      manifest: { schedule: "*/15 * * * *" },
    });
    const { listGrants } = await import("./grants");
    expect((await listGrants()).find((p) => p.name === "a")?.schedule).toBe("*/5 * * * *");
  });

  it("schedule null and legacy-absent both read as disabled", async () => {
    seed("b", { version: "1.0.0", schedule: null, manifest: { schedule: "*/15 * * * *" } });
    seed("c", { version: "1.0.0", manifest: { schedule: "*/15 * * * *" } });
    const { listGrants } = await import("./grants");
    const list = await listGrants();
    // Consumers gate on truthiness; null and absent must both be falsy.
    expect(list.find((p) => p.name === "b")?.schedule).toBeFalsy();
    expect(list.find((p) => p.name === "c")?.schedule).toBeFalsy();
  });

  it("read-modify-write via writeGrants preserves fields it didn't touch", async () => {
    seed("d", {
      version: "1.0.0",
      env: { TOKEN: "x" },
      files: { export: "/tmp/x" },
      net: ["api.example.com"],
      custom: "kept",
    });
    const { readGrants, writeGrants } = await import("./grants");
    const g = (await readGrants("d"))!;
    g.schedule = "every 15min";
    await writeGrants("d", g);
    const raw = JSON.parse(readFileSync(join(home, "grants", "d.json"), "utf-8"));
    expect(raw.env).toEqual({ TOKEN: "x" });
    expect(raw.files).toEqual({ export: "/tmp/x" });
    expect(raw.net).toEqual(["api.example.com"]);
    expect(raw.custom).toBe("kept");
    expect(raw.schedule).toBe("every 15min");
  });

  it("listGrants sorts by name and skips non-json files", async () => {
    seed("zeta", { version: "1" });
    seed("alpha", { version: "1" });
    writeFileSync(join(home, "grants", "README.txt"), "not grants");
    const { listGrants } = await import("./grants");
    expect((await listGrants()).map((g) => g.name)).toEqual(["alpha", "zeta"]);
  });
});
