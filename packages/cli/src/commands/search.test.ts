import { describe, it, expect } from "vitest";
import { markTerms, renderSnippet } from "./search";

const B = (s: string) => `<B>${s}</B>`;
const D = (s: string) => `<D>${s}</D>`;

describe("markTerms", () => {
  it("wraps whole-word, case-insensitive matches in bold", () => {
    const out = markTerms("Ranking signals decay", ["ranking", "signals"], B, D);
    expect(out).toBe("<B>Ranking</B><D> </D><B>signals</B><D> decay</D>");
  });

  it("does not match substrings inside larger words", () => {
    const out = markTerms("Rankings tower over time", ["rank"], B, D);
    expect(out).toBe("Rankings tower over time"); // no matches → raw text returned
  });

  it("handles regex metacharacters in terms without throwing", () => {
    expect(() => markTerms("text (parens) [brackets]", ["(parens)", "[brackets]"], B, D)).not.toThrow();
  });

  it("returns text unchanged when terms is empty", () => {
    expect(markTerms("hello world", [], B, D)).toBe("hello world");
  });

  it("dims trailing text after the last match", () => {
    const out = markTerms("foo bar baz", ["foo"], B, D);
    expect(out).toBe("<B>foo</B><D> bar baz</D>");
  });
});

describe("renderSnippet", () => {
  it("returns plain text when useColor is false", () => {
    const out = renderSnippet("Ranking signals decay", ["ranking"], 100, false);
    expect(out).toBe("Ranking signals decay");
  });

  it("truncates to maxWidth with trailing ellipsis", () => {
    const out = renderSnippet("a".repeat(50), [], 10, false);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses internal whitespace into single spaces", () => {
    expect(renderSnippet("foo\n\n   bar\tbaz", [], 100, false)).toBe("foo bar baz");
  });
});
