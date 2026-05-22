import { describe, expect, it } from "vitest";
import { sanitizePluginText, wrapPluginText } from "./untrusted-text";

describe("sanitizePluginText", () => {
  it("passes plain text through", () => {
    expect(sanitizePluginText("hello world")).toEqual({ text: "hello world", truncated: false });
  });

  it("preserves utf-8 printable (emoji, accents)", () => {
    expect(sanitizePluginText("café — 🔑 résumé").text).toBe("café — 🔑 résumé");
  });

  it("strips ANSI CSI color codes", () => {
    expect(sanitizePluginText("\x1b[31mred\x1b[0m text").text).toBe("red text");
  });

  it("strips ANSI CSI cursor moves and clear-screen", () => {
    expect(sanitizePluginText("\x1b[2J\x1b[H\x1b[1;1Hhi").text).toBe("hi");
  });

  it("strips ANSI CSI with private-mode params", () => {
    expect(sanitizePluginText("\x1b[?25lhidden\x1b[?25h").text).toBe("hidden");
  });

  it("strips OSC 8 hyperlinks terminated by BEL", () => {
    const raw = "\x1b]8;;https://evil/\x07click me\x1b]8;;\x07 ok";
    expect(sanitizePluginText(raw).text).toBe("click me ok");
  });

  it("strips OSC 8 hyperlinks terminated by ST (ESC backslash)", () => {
    const raw = "\x1b]8;;https://evil/\x1b\\click\x1b]8;;\x1b\\ ok";
    expect(sanitizePluginText(raw).text).toBe("click ok");
  });

  it("strips stray Fe escape bytes", () => {
    expect(sanitizePluginText("a\x1bDb").text).toBe("ab");
  });

  it("normalizes CRLF and bare CR to LF", () => {
    expect(sanitizePluginText("a\r\nb\rc").text).toBe("a\nb\nc");
  });

  it("replaces NUL and other control chars with ?", () => {
    expect(sanitizePluginText("a\x00b\x07c\x7fd").text).toBe("a?b?c?d");
  });

  it("preserves LF as a hard newline", () => {
    expect(sanitizePluginText("a\nb").text).toBe("a\nb");
  });

  it("collapses runs of blank lines to one", () => {
    expect(sanitizePluginText("a\n\n\n\nb").text).toBe("a\n\nb");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizePluginText("  hi  ").text).toBe("hi");
  });

  it("truncates above 500 chars with ellipsis and flag", () => {
    const result = sanitizePluginText("x".repeat(600));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(500);
    expect(result.text.endsWith("…")).toBe(true);
  });

  it("does not truncate at exactly 500 chars", () => {
    const result = sanitizePluginText("x".repeat(500));
    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(500);
  });
});

describe("wrapPluginText", () => {
  it("returns input unchanged when it fits", () => {
    expect(wrapPluginText("hello world", 40)).toEqual(["hello world"]);
  });

  it("wraps at word boundaries", () => {
    expect(wrapPluginText("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("respects existing newlines as hard breaks", () => {
    expect(wrapPluginText("para one\npara two", 40)).toEqual(["para one", "para two"]);
  });

  it("preserves blank lines as empty entries", () => {
    expect(wrapPluginText("a\n\nb", 40)).toEqual(["a", "", "b"]);
  });

  it("force-breaks words longer than width", () => {
    expect(wrapPluginText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("force-breaks long word adjacent to short words", () => {
    expect(wrapPluginText("hi abcdefghij bye", 4)).toEqual(["hi", "abcd", "efgh", "ij", "bye"]);
  });

  it("width matrix — 40", () => {
    const lines = wrapPluginText("the quick brown fox jumps over the lazy dog", 40);
    expect(lines.every((l) => l.length <= 40)).toBe(true);
  });

  it("width matrix — 60", () => {
    const lines = wrapPluginText("the quick brown fox jumps over the lazy dog", 60);
    expect(lines).toEqual(["the quick brown fox jumps over the lazy dog"]);
  });

  it("width matrix — 80", () => {
    const lorem = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";
    const lines = wrapPluginText(lorem, 80);
    expect(lines.every((l) => l.length <= 80)).toBe(true);
  });

  it("width matrix — 100", () => {
    const lines = wrapPluginText("a ".repeat(60).trim(), 100);
    expect(lines.every((l) => l.length <= 100)).toBe(true);
  });
});
