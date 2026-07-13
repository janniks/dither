import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ECHO_FIXTURE = resolve(__dirname, "..", "test", "fixtures", "echo-config");
const IMPORT_FIXTURE = resolve(__dirname, "..", "test", "fixtures", "import-folder");

describe("plugin lifecycle (list / remove)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-lifecycle-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.DITHER_DIR;
    } else {
      process.env.DITHER_DIR = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("listGrants returns empty array on a fresh install", async () => {
    const { listGrants } = await import("./grants");
    expect(await listGrants()).toEqual([]);
  });

  it("listGrants returns installed plugins with name/version/collections", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { listGrants } = await import("./grants");

    await installPlugin({ source: IMPORT_FIXTURE });
    await installPlugin({
      source: ECHO_FIXTURE,
      env: { GREETING: "x", API_TOKEN: "y" },
    });

    const list = await listGrants();
    expect(list).toHaveLength(2);
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(byName["import-folder"]?.version).toBe("0.0.1");
    expect(byName["import-folder"]?.create).toContain("imported");
    expect(byName["echo-config"]?.create).toContain("echoed");
  });

  it("removePlugin deletes plugin dir + grants and listGrants reflects it", async () => {
    const { installPlugin } = await import("./plugin-install");
    const { listGrants } = await import("./grants");
    const { removePlugin } = await import("./plugin-remove");

    await installPlugin({ source: IMPORT_FIXTURE });
    expect((await listGrants()).map((p) => p.name)).toContain("import-folder");
    expect(existsSync(join(home, "plugins", "import-folder"))).toBe(true);
    expect(existsSync(join(home, "grants", "import-folder.json"))).toBe(true);

    await removePlugin({ name: "import-folder" });

    expect(existsSync(join(home, "plugins", "import-folder"))).toBe(false);
    expect(existsSync(join(home, "grants", "import-folder.json"))).toBe(false);
    expect(await listGrants()).toEqual([]);
  });

  it("removePlugin throws when the plugin is not installed", async () => {
    const { removePlugin } = await import("./plugin-remove");
    await expect(removePlugin({ name: "ghost" })).rejects.toThrow(/not installed/);
  });
});

describe("status", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-status-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    const lib = join(home, "entries");
    mkdirSync(lib, { recursive: true });
    await writeTestConfig(lib);
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.DITHER_DIR;
    } else {
      process.env.DITHER_DIR = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("getStatus reports zero counts on a fresh home", async () => {
    const { getStatus } = await import("./status");
    const status = await getStatus();
    expect(status.home).toBe(home);
    expect(status.plugins).toBe(0);
    expect(status.collections).toBe(0);
    expect(status.entries).toBe(0);
  });

  it("getStatus reports counts after installs and entries are written", async () => {
    const { installPlugin } = await import("./plugin-install");
    await installPlugin({ source: IMPORT_FIXTURE });

    const notes = join(home, "entries", "notes");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "a.md"), "---\ntitle: a\n---\n\nhi\n");
    writeFileSync(join(notes, "b.md"), "---\ntitle: b\n---\n\nhi\n");

    // Counts come from the qmd store, not a directory walk — index first.
    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { getStatus } = await import("./status");
    const status = await getStatus();
    expect(status.plugins).toBe(1);
    expect(status.collections).toBe(1);
    expect(status.entries).toBe(2);
  });
});
