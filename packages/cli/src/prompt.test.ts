import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { composePromptMessage } from "./prompt";

describe("composePromptMessage", () => {
  it("returns message unchanged when no default", () => {
    expect(composePromptMessage("name", undefined)).toBe("name");
  });

  it("appends ENTER hint when default present", () => {
    expect(composePromptMessage("path", "/tmp/foo")).toBe("path (ENTER for /tmp/foo)");
  });

  it("collapses $HOME to ~ in the hint", () => {
    const home = homedir();
    expect(composePromptMessage("dir", `${home}/Library/Messages`)).toBe(
      "dir (ENTER for ~/Library/Messages)",
    );
  });

  it("skips auto-append when caller already mentions ENTER", () => {
    const msg = "Where? (ENTER for ~/dither)";
    expect(composePromptMessage(msg, "/Users/x/dither")).toBe(msg);
  });
});
