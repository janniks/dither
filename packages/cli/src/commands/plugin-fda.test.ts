import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_INFO = {
  path: "/Users/x/Library/Messages",
  callerBinary: "/Users/x/.config/dither/bin/deno-2.7.13",
  settingsUri: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};

function captureStdout(): { all(): string; restore(): void } {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    out.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    all: () => out.join(""),
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

describe("handleProtectedInstall", () => {
  let prevStdin: boolean | undefined;
  let prevStdout: boolean | undefined;

  beforeEach(() => {
    prevStdin = process.stdin.isTTY;
    prevStdout = process.stdout.isTTY;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevStdin === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else process.stdin.isTTY = prevStdin;
    if (prevStdout === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else process.stdout.isTTY = prevStdout;
    vi.doUnmock("../prompt");
    vi.restoreAllMocks();
  });

  it("renders the FDA note and skips the prompt on non-TTY", async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    const cap = captureStdout();
    const open = vi.fn();
    const { handleProtectedInstall } = await import("./plugin");
    try {
      await handleProtectedInstall(FAKE_INFO, open);
      const all = cap.all();
      expect(all).toContain("/Users/x/Library/Messages");
      expect(all).toContain("Full Disk Access");
      expect(open).not.toHaveBeenCalled();
    } finally {
      cap.restore();
    }
  });

  it("on TTY + Yes, opens the settings URI", async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.doMock("../prompt", async () => {
      const actual = await vi.importActual<typeof import("../prompt")>("../prompt");
      return { ...actual, promptConfirm: vi.fn(async () => true) };
    });
    const cap = captureStdout();
    const open = vi.fn();
    const { handleProtectedInstall } = await import("./plugin");
    try {
      await handleProtectedInstall(FAKE_INFO, open);
      expect(open).toHaveBeenCalledWith(FAKE_INFO.settingsUri);
    } finally {
      cap.restore();
    }
  });

  it("on TTY + No, does not open settings", async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.doMock("../prompt", async () => {
      const actual = await vi.importActual<typeof import("../prompt")>("../prompt");
      return { ...actual, promptConfirm: vi.fn(async () => false) };
    });
    const cap = captureStdout();
    const open = vi.fn();
    const { handleProtectedInstall } = await import("./plugin");
    try {
      await handleProtectedInstall(FAKE_INFO, open);
      expect(open).not.toHaveBeenCalled();
    } finally {
      cap.restore();
    }
  });

  it("Ctrl-C (prompt reject) leaves the URL in the note and does not open", async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.doMock("../prompt", async () => {
      const actual = await vi.importActual<typeof import("../prompt")>("../prompt");
      return {
        ...actual,
        promptConfirm: vi.fn(async () => {
          throw new Error("cancelled");
        }),
      };
    });
    const cap = captureStdout();
    const open = vi.fn();
    const { handleProtectedInstall } = await import("./plugin");
    try {
      await handleProtectedInstall(FAKE_INFO, open);
      expect(open).not.toHaveBeenCalled();
      expect(cap.all()).toContain(FAKE_INFO.settingsUri);
    } finally {
      cap.restore();
    }
  });
});
