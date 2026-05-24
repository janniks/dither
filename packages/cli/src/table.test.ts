import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printTable } from "./table";

function capture(): { lines(): string[]; restore(): void } {
  const buf: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => buf.push(typeof s === "string" ? s : String(s));
  return {
    lines: () => buf,
    restore: () => {
      console.log = orig;
    },
  };
}

describe("printTable (TTY)", () => {
  let prevTTY: boolean | undefined;
  let prevCols: number | undefined;
  let cap: ReturnType<typeof capture>;

  beforeEach(() => {
    prevTTY = process.stdout.isTTY;
    prevCols = process.stdout.columns;
    process.stdout.isTTY = true;
    process.stdout.columns = 100;
    cap = capture();
  });

  afterEach(() => {
    cap.restore();
    if (prevTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else process.stdout.isTTY = prevTTY;
    if (prevCols === undefined) delete (process.stdout as { columns?: number }).columns;
    else process.stdout.columns = prevCols;
  });

  it("empty rows: nothing printed", () => {
    printTable([]);
    expect(cap.lines()).toEqual([]);
  });

  it("computes widths from longest cell per column", () => {
    printTable([
      ["a", "short"],
      ["bbbb", "x"],
    ]);
    // col0 width 4 (max of "a","bbbb"), GAP "  ", last col unpadded
    expect(cap.lines()).toEqual(["a     short", "bbbb  x"]);
  });

  it("right-aligns when align: right", () => {
    printTable(
      [
        ["foo", "10"],
        ["bar", "1234"],
      ],
      [{}, { align: "right" }],
    );
    expect(cap.lines()).toEqual(["foo    10", "bar  1234"]);
  });

  it("respects min width", () => {
    printTable(
      [["a", "b"]],
      [{ min: 8 }],
    );
    expect(cap.lines()[0]!.startsWith("a       ")).toBe(true);
  });

  it("middle-truncates a column when max exceeded", () => {
    printTable(
      [["short", "x"], ["this-is-a-very-long-name", "y"]],
      [{ max: 10 }],
    );
    // 24 chars cropped to 10 with middle ellipsis
    expect(cap.lines()[1]!.startsWith("this…-name")).toBe(true);
  });

  it("clamps last column to terminal width to avoid wrap", () => {
    process.stdout.columns = 30;
    const longTail = "x".repeat(60);
    printTable([["abc", longTail]]);
    const line = cap.lines()[0]!;
    expect(line.length).toBeLessThanOrEqual(30);
    expect(line).toContain("…");
  });

  it("applies color callback to padded cell", () => {
    printTable(
      [["a", "b"]],
      [{ color: (s) => `<${s}>` }, {}],
    );
    expect(cap.lines()[0]!.startsWith("<a>")).toBe(true);
  });
});

describe("printTable (non-TTY)", () => {
  let prevTTY: boolean | undefined;
  let cap: ReturnType<typeof capture>;

  beforeEach(() => {
    prevTTY = process.stdout.isTTY;
    process.stdout.isTTY = false;
    cap = capture();
  });

  afterEach(() => {
    cap.restore();
    if (prevTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else process.stdout.isTTY = prevTTY;
  });

  it("emits raw TSV, no padding, ignores color", () => {
    printTable(
      [["a", "10"], ["bbbb", "1"]],
      [{ align: "right", color: (s) => `<${s}>` }, {}],
    );
    expect(cap.lines()).toEqual(["a\t10", "bbbb\t1"]);
  });
});
