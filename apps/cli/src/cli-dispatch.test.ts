import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "citty";

const FIXTURE_PATH = resolve(__dirname, "..", "test", "fixtures", "import-folder");

/**
 * Capture console.log output for the duration of the callback. We assert
 * against stdout because that's what the user sees — it's the public
 * interface of a CLI subcommand.
 */
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

describe("CLI dispatch", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-test-"));
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

  it("dither search <query> prints matching paths to stdout", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "auth.md"),
      "---\ntitle: Authentication\n---\n\nAuth flow notes.\n",
    );

    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { main } = await import("./main");
    const output = await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["search", "Auth", "--mode", "lex"],
      });
    });

    expect(output).toContain("notes/auth.md");
  });

  it("dither get <ref> prints the entry body to stdout", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "doc.md"),
      "---\ntitle: Doc\n---\n\nLine A.\nLine B.\nLine C.\n",
    );
    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { main } = await import("./main");
    const output = await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["get", "notes/doc.md"],
      });
    });

    expect(output).toContain("Line A.");
    expect(output).toContain("Line C.");
  });

  it("dither get --lines start:end prints only the requested range", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "ranges.md"),
      ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5", "Line 6", "Line 7", ""].join("\n"),
    );
    const { updateIndex } = await import("./update-index");
    await updateIndex();

    const { main } = await import("./main");
    const output = await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["get", "notes/ranges.md", "--lines", "3:5"],
      });
    });

    expect(output).toContain("Line 3");
    expect(output).toContain("Line 4");
    expect(output).toContain("Line 5");
    expect(output).not.toContain("Line 1");
    expect(output).not.toContain("Line 7");
  });

  it("dither index update reports counts and makes content findable", async () => {
    const collectionDir = join(home, "entries", "notes");
    mkdirSync(collectionDir, { recursive: true });
    writeFileSync(
      join(collectionDir, "memo.md"),
      "---\ntitle: Memo\n---\n\nThis memo discusses widgets.\n",
    );

    const { main } = await import("./main");
    const updateOut = await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["index", "update"],
      });
    });
    expect(updateOut).toContain("index updated:");

    const searchOut = await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["search", "widgets", "--mode", "lex"],
      });
    });
    expect(searchOut).toContain("notes/memo.md");
  });

  it("dither plugin install + run end-to-end via subcommands", async () => {
    const { main } = await import("./main");

    await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["plugin", "install", FIXTURE_PATH],
      });
    });

    expect(existsSync(join(home, "plugins", "import-folder"))).toBe(true);

    await captureLogs(async () => {
      await runCommand(main, {
        rawArgs: ["plugin", "run", "import-folder"],
      });
    });

    const importedDir = join(home, "entries", "imported");
    expect(existsSync(importedDir)).toBe(true);
    const promoted = readdirSync(importedDir).filter((f) => f.endsWith(".md"));
    expect(promoted.length).toBeGreaterThan(0);
  }, 60000);
});
