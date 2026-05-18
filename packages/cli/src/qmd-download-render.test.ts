import { describe, expect, it } from "vitest";
import { parseDownloadSummary, virtualYDelta } from "./qmd-download-render";

describe("parseDownloadSummary", () => {
  it("parses a typical qmd download block", () => {
    // Two `console.info` lines from node-llama-cpp's resolveModelFile,
    // interleaved with an ipull/stdout-update progress bar trace. We
    // simulate the bar's final-frame content here; the exact bytes
    // include ANSI color codes that the parser strips.
    const buffer = [
      "Downloading to \x1b[33m~/.cache/qmd/models\x1b[39m",
      "",
      "\x1b[32m✔\x1b[39m hf_ggml-org_embeddinggemma-300M-Q8_0.gguf downloaded 333.59MB in 2m",
      "Downloaded to \x1b[33m~/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf\x1b[39m",
      "",
    ].join("\n");
    const summary = parseDownloadSummary(buffer);
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      size: "333.59MB",
      duration: "2m",
    });
    expect(summary!.path).toMatch(/hf_ggml-org_embeddinggemma-300M-Q8_0\.gguf$/);
  });

  it("parses minute+second duration form", () => {
    const buffer =
      "✔ model.gguf downloaded 1.2GB in 5m 18s\nDownloaded to /opt/cache/model.gguf\n";
    const summary = parseDownloadSummary(buffer);
    expect(summary).toMatchObject({ size: "1.2GB", duration: "5m 18s" });
  });

  it("parses seconds-only duration", () => {
    const buffer =
      "✔ small.gguf downloaded 45.0MB in 12s\nDownloaded to /tmp/small.gguf\n";
    const summary = parseDownloadSummary(buffer);
    expect(summary).toMatchObject({ size: "45.0MB", duration: "12s" });
  });

  it("returns null when the size/duration line is missing", () => {
    const buffer = "Downloaded to /tmp/x.gguf\n";
    expect(parseDownloadSummary(buffer)).toBeNull();
  });

  it("returns null when the Downloaded-to line is missing", () => {
    const buffer = "✔ x.gguf downloaded 100MB in 1m\n";
    expect(parseDownloadSummary(buffer)).toBeNull();
  });

  it("returns null for entirely unrelated content", () => {
    expect(parseDownloadSummary("foo bar baz\nhello world\n")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseDownloadSummary("")).toBeNull();
  });

  it("tildifies a home-directory path", () => {
    // tildePath turns $HOME into ~. We don't pin a specific path here —
    // just assert it doesn't include a raw '/Users/<name>' segment if it
    // would have been under HOME. Hard to test portably; instead assert
    // the path is returned as-is when it's already outside HOME.
    const buffer =
      "✔ x.gguf downloaded 1MB in 1s\nDownloaded to /opt/models/x.gguf\n";
    expect(parseDownloadSummary(buffer)?.path).toBe("/opt/models/x.gguf");
  });
});

describe("virtualYDelta", () => {
  it("counts newlines", () => {
    expect(virtualYDelta("hello\nworld\n")).toBe(2);
    expect(virtualYDelta("no newlines here")).toBe(0);
  });

  it("subtracts on cursor-up sequences", () => {
    expect(virtualYDelta("\x1b[3A")).toBe(-3);
    expect(virtualYDelta("\x1b[A")).toBe(-1); // implicit count = 1
  });

  it("adds on cursor-down sequences", () => {
    expect(virtualYDelta("\x1b[2B")).toBe(2);
  });

  it("handles a redrawn progress-bar frame", () => {
    // ipull's stdout-update emits something like: cursor-up N, then write
    // N lines of new bar content. Net Y change should be 0.
    const frame = "\x1b[3A\x1b[K bar line 1\n\x1b[K bar line 2\n\x1b[K bar line 3\n";
    expect(virtualYDelta(frame)).toBe(0);
  });

  it("ignores unrelated CSI sequences (color, erase-line, column)", () => {
    expect(virtualYDelta("\x1b[31mred\x1b[39m\x1b[K\x1b[5G")).toBe(0);
  });

  it("sums across multiple lines + cursor moves", () => {
    // Initial 5 lines (Downloading to + 3 bar lines + Downloaded to),
    // two balanced bar redraws (each up-3 then 3 newlines, net 0).
    // Final cursor 5 lines below start.
    const initial =
      "Downloading to ~/...\n" +
      "  spinner\n  status\n  progress\n" +
      "Downloaded to ~/...\n";
    const redraw1 = "\x1b[3A\x1b[K  spinner\n\x1b[K  status\n\x1b[K  progress\n";
    const redraw2 = "\x1b[3A\x1b[K  spinner\n\x1b[K  status\n\x1b[K  progress\n";
    expect(virtualYDelta(initial + redraw1 + redraw2)).toBe(5);
  });
});
