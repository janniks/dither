import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function writePlugin(dir: string, version: string, body: string, collections: string[]): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "rollback",
      version,
      dither: { collections },
    }),
  );
  writeFileSync(join(dir, "plugin.ts"), body);
}

describe("installPlugin", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "dither-plugin-install-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    const { writeTestConfig } = await import("../test/helpers/config");
    await writeTestConfig(join(home, "entries"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.doUnmock("./deno-bootstrap");
    vi.doUnmock("./secure-json");
    vi.resetModules();
    if (prevHome === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps the previous install and grants when reinstall prefetch fails", async () => {
    const exits = [0, 1];
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      const code = exits.shift() ?? 1;
      process.nextTick(() => child.emit("exit", code));
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("./deno-bootstrap", () => ({
      ensureDeno: vi.fn(async () => "/bin/deno"),
    }));

    const oldSource = mkdtempSync(join(tmpdir(), "dither-old-plugin-"));
    const newSource = mkdtempSync(join(tmpdir(), "dither-new-plugin-"));
    writePlugin(oldSource, "1.0.0", "// old\n", ["old"]);
    writePlugin(newSource, "2.0.0", "// new\n", ["new"]);

    try {
      const { installPlugin } = await import("./plugin-install");
      await installPlugin({ source: oldSource });

      await expect(installPlugin({ source: newSource })).rejects.toThrow(/deno cache/);

      expect(readFileSync(join(home, "plugins", "rollback", "plugin.ts"), "utf-8")).toBe(
        "// old\n",
      );
      expect(
        JSON.parse(readFileSync(join(home, "plugins", "rollback", "package.json"), "utf-8"))
          .version,
      ).toBe("1.0.0");

      const grants = JSON.parse(readFileSync(join(home, "grants", "rollback.json"), "utf-8"));
      expect(grants.version).toBe("1.0.0");
      expect(grants.collections).toEqual(["old"]);
      expect(existsSync(join(home, "plugins", "rollback"))).toBe(true);
    } finally {
      rmSync(oldSource, { recursive: true, force: true });
      rmSync(newSource, { recursive: true, force: true });
    }
  });

  it("rolls back plugin code when grants write fails during reinstall", async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 0));
      return child;
    });
    const writes = [true, false];
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("./deno-bootstrap", () => ({
      ensureDeno: vi.fn(async () => "/bin/deno"),
    }));
    vi.doMock("./secure-json", async () => {
      const actual = await vi.importActual<typeof import("./secure-json")>("./secure-json");
      return {
        ...actual,
        writePrivateJson: vi.fn(async (...args: Parameters<typeof actual.writePrivateJson>) => {
          if (!writes.shift()) throw new Error("grants failed");
          await actual.writePrivateJson(...args);
        }),
      };
    });

    const oldSource = mkdtempSync(join(tmpdir(), "dither-old-plugin-"));
    const newSource = mkdtempSync(join(tmpdir(), "dither-new-plugin-"));
    writePlugin(oldSource, "1.0.0", "// old\n", ["old"]);
    writePlugin(newSource, "2.0.0", "// new\n", ["new"]);

    try {
      const { installPlugin } = await import("./plugin-install");
      await installPlugin({ source: oldSource });

      await expect(installPlugin({ source: newSource })).rejects.toThrow(/grants failed/);

      expect(readFileSync(join(home, "plugins", "rollback", "plugin.ts"), "utf-8")).toBe(
        "// old\n",
      );
      const grants = JSON.parse(readFileSync(join(home, "grants", "rollback.json"), "utf-8"));
      expect(grants.version).toBe("1.0.0");
      expect(grants.collections).toEqual(["old"]);
    } finally {
      rmSync(oldSource, { recursive: true, force: true });
      rmSync(newSource, { recursive: true, force: true });
    }
  });

  it("persists user-consented schedule + watch at the top level; manifest block preserved", async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 0));
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("./deno-bootstrap", () => ({
      ensureDeno: vi.fn(async () => "/bin/deno"),
    }));

    const src = mkdtempSync(join(tmpdir(), "dither-consent-plugin-"));
    writeFileSync(
      join(src, "package.json"),
      JSON.stringify({
        name: "consent",
        version: "1.0.0",
        dither: {
          schedule: "*/15 * * * *",
          watch: { collections: ["msg/**"] },
          collections: ["msg/**"],
        },
      }),
    );
    writeFileSync(join(src, "plugin.ts"), "// x\n");

    try {
      const { installPlugin } = await import("./plugin-install");
      // User picked Manual + disabled watch.
      await installPlugin({ source: src, schedule: null, watch: null });

      const grants = JSON.parse(readFileSync(join(home, "grants", "consent.json"), "utf-8"));
      expect(grants.schedule).toBeNull();
      expect(grants.watch).toBeNull();
      // Manifest block stays as declared so debug / `plugin list` can show
      // the original schedule.
      expect(grants.manifest.schedule).toBe("*/15 * * * *");
      expect(grants.manifest.watch).toEqual({ collections: ["msg/**"] });
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("persists a custom-cron consent string at grants.schedule", async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 0));
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("./deno-bootstrap", () => ({
      ensureDeno: vi.fn(async () => "/bin/deno"),
    }));

    const src = mkdtempSync(join(tmpdir(), "dither-custom-cron-"));
    writeFileSync(
      join(src, "package.json"),
      JSON.stringify({
        name: "custom",
        version: "1.0.0",
        dither: { schedule: "*/15 * * * *", collections: ["c/**"] },
      }),
    );
    writeFileSync(join(src, "plugin.ts"), "// x\n");

    try {
      const { installPlugin } = await import("./plugin-install");
      await installPlugin({ source: src, schedule: "*/30 * * * *" });

      const grants = JSON.parse(readFileSync(join(home, "grants", "custom.json"), "utf-8"));
      expect(grants.schedule).toBe("*/30 * * * *");
      expect(grants.manifest.schedule).toBe("*/15 * * * *");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
