import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("plugin SDK state I/O", () => {
  let dir: string;
  let path: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dither-plugin-state-"));
    path = join(dir, "state.json");
    prev = process.env.DITHER_STATE_FILE;
    process.env.DITHER_STATE_FILE = path;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_STATE_FILE;
    else process.env.DITHER_STATE_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("readState returns the initial value when no file exists", async () => {
    const sdk = await import("./index");
    const initial = { cursor: "init" };
    expect(await sdk.readState(initial)).toEqual(initial);
  });

  it("writeState produces the final file and leaves no tmp siblings", async () => {
    const sdk = await import("./index");
    await sdk.writeState({ cursor: "abc" });

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ cursor: "abc" });

    const stragglers = readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });

  it("writeState round-trips through readState", async () => {
    const sdk = await import("./index");
    await sdk.writeState({ cursor: "xyz", count: 3 });
    expect(await sdk.readState({ cursor: "", count: 0 })).toEqual({
      cursor: "xyz",
      count: 3,
    });
  });
});
