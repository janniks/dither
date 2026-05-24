import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FDA_SETTINGS_URI,
  detectProtectedInstall,
  findProtectedPathInError,
  formatFdaError,
  isMacOS,
  tccPrefixFor,
} from "./tcc-hint";

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

  it("findProtectedPathInError extracts the path from a Deno-style error blob", () => {
    const blob = `error: Uncaught (in promise) Error: EPERM: operation not permitted, open '${join(
      home,
      "Library/Messages/chat.db",
    )}'\n    at node:fs:320:24`;
    expect(findProtectedPathInError(blob)).toBe(join(home, "Library/Messages/chat.db"));
  });

  it("findProtectedPathInError extracts quoted Application Support paths", () => {
    const path = join(home, "Library/Application Support/AddressBook/Sources/x");
    const blob = `EPERM: operation not permitted, open '${path}'`;
    expect(findProtectedPathInError(blob)).toBe(path);
  });

  it("findProtectedPathInError extracts unquoted Application Support paths", () => {
    const path = join(home, "Library/Application Support/com.apple.TCC/TCC.db");
    const blob = `EPERM: operation not permitted, open ${path}`;
    expect(findProtectedPathInError(blob)).toBe(path);
  });

  it("findProtectedPathInError returns null for unprotected paths", () => {
    expect(findProtectedPathInError("EPERM: opening /etc/passwd")).toBeNull();
    expect(findProtectedPathInError("nothing to see here")).toBeNull();
  });

  it("formatFdaError produces a clean message — no terminal recommendation, no stack", () => {
    const msg = formatFdaError(join(home, "Library/Messages/chat.db"), "/usr/local/bin/node");
    expect(msg).toContain("FDA_REQUIRED");
    expect(msg).toContain("EPERM");
    expect(msg).toContain("/usr/local/bin/node");
    expect(msg).toContain(FDA_SETTINGS_URI);
    // We deliberately do not recommend granting FDA to a terminal app.
    expect(msg).not.toMatch(/terminal app|iTerm|Terminal\.app|Ghostty|Warp/);
    // No stack-trace style file:line refs.
    expect(msg).not.toMatch(/\.ts:\d+:\d+|\.mjs:\d+:\d+|\.js:\d+:\d+|node:fs/);
  });

  it("detectProtectedInstall returns structured info for a protected path", () => {
    const info = detectProtectedInstall({
      chat: join(home, "Library", "Messages", "chat.db"),
    });
    expect(info).not.toBeNull();
    expect(info?.path).toBe(join(home, "Library", "Messages", "chat.db"));
    expect(info?.settingsUri).toBe(FDA_SETTINGS_URI);
    expect(info?.callerBinary).toMatch(/deno/);
  });

  it("detectProtectedInstall returns null for unprotected paths", () => {
    expect(detectProtectedInstall({ doc: join(home, "Documents", "x.txt") })).toBeNull();
  });

  it("detectProtectedInstall returns null for an empty grants set", () => {
    expect(detectProtectedInstall({})).toBeNull();
  });
});

runOffMac("TCC hint (non-macOS)", () => {
  it("tccPrefixFor always returns null", () => {
    expect(tccPrefixFor("/anything")).toBeNull();
  });

  it("detectProtectedInstall is a no-op off macOS", () => {
    expect(detectProtectedInstall({ x: "/Library/Messages/chat.db" })).toBeNull();
  });
});
