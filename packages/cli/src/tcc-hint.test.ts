import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { tccPrefixFor, fdaHint, maybeWarnInstall, isMacOS, wrapRuntimeError } from "./tcc-hint";

const runOnMac = isMacOS() ? describe : describe.skip;
const runOffMac = isMacOS() ? describe.skip : describe;

runOnMac("TCC hint (macOS)", () => {
  const home = homedir();

  it("matches a protected path", () => {
    expect(tccPrefixFor(join(home, "Library", "Messages", "chat.db"))).toBe("Library/Messages");
    expect(tccPrefixFor(join(home, "Library", "Calendars", "x.ics"))).toBe("Library/Calendars");
  });

  it("rejects a non-protected path", () => {
    expect(tccPrefixFor(join(home, "Documents", "notes.md"))).toBeNull();
    expect(tccPrefixFor("/etc/passwd")).toBeNull();
  });

  it("fdaHint mentions the binary path", () => {
    const hint = fdaHint("/usr/local/bin/dither");
    expect(hint).toContain("Full Disk Access");
    expect(hint).toContain("/usr/local/bin/dither");
  });

  it("maybeWarnInstall prints when a granted path is protected", () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (s: string) => errs.push(s);
    try {
      const fired = maybeWarnInstall({
        chat: join(home, "Library", "Messages", "chat.db"),
      });
      expect(fired).toBe(true);
      expect(errs.join("\n")).toContain("Full Disk Access");
    } finally {
      console.error = orig;
    }
  });

  it("maybeWarnInstall is silent for unprotected paths", () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (s: string) => errs.push(s);
    try {
      const fired = maybeWarnInstall({ doc: join(home, "Documents", "x.txt") });
      expect(fired).toBe(false);
      expect(errs).toHaveLength(0);
    } finally {
      console.error = orig;
    }
  });

  it("wrapRuntimeError attaches hint for EPERM on protected path", () => {
    const err = Object.assign(new Error("EPERM: operation not permitted"), {
      code: "EPERM",
      path: join(home, "Library", "Messages", "chat.db"),
    });
    const wrapped = wrapRuntimeError(err);
    expect(wrapped.message).toContain("Full Disk Access");
  });

  it("wrapRuntimeError leaves non-EPERM errors alone", () => {
    const err = new Error("ENOENT no such file");
    const wrapped = wrapRuntimeError(err);
    expect(wrapped).toBe(err);
  });
});

runOffMac("TCC hint (non-macOS)", () => {
  it("tccPrefixFor always returns null", () => {
    expect(tccPrefixFor("/anything")).toBeNull();
  });

  it("maybeWarnInstall is a no-op", () => {
    expect(maybeWarnInstall({ x: "/Library/Messages/chat.db" })).toBe(false);
  });
});
