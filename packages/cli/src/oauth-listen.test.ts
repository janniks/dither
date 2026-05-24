import { describe, expect, it } from "vitest";
import { listenForCode } from "./oauth-listen";

async function fire(port: number, query: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/callback${query}`);
  await res.text();
}

describe("listenForCode", () => {
  it("resolves with code when /callback?code=X&state=expected", async () => {
    const promise = listenForCode({
      port: 0,
      expectedState: "ST",
      timeoutMs: 5000,
      onReady: (port) => void fire(port, "?code=THE_CODE&state=ST"),
    });
    await expect(promise).resolves.toBe("THE_CODE");
  });

  it("rejects on state mismatch", async () => {
    const promise = listenForCode({
      port: 0,
      expectedState: "ST",
      timeoutMs: 5000,
      onReady: (port) => void fire(port, "?code=X&state=OTHER"),
    });
    await expect(promise).rejects.toThrow(/state mismatch/);
  });

  it("rejects when provider returns ?error=", async () => {
    const promise = listenForCode({
      port: 0,
      expectedState: "ST",
      timeoutMs: 5000,
      onReady: (port) => void fire(port, "?error=access_denied"),
    });
    await expect(promise).rejects.toThrow(/access_denied/);
  });

  it("rejects after timeout if no callback arrives", async () => {
    const t0 = Date.now();
    await expect(
      listenForCode({ port: 0, expectedState: "ST", timeoutMs: 80 }),
    ).rejects.toThrow(/no callback/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it("closes the server so the port is reusable", async () => {
    let firstPort = 0;
    await listenForCode({
      port: 0,
      expectedState: "ST",
      timeoutMs: 5000,
      onReady: (port) => {
        firstPort = port;
        void fire(port, "?code=X&state=ST");
      },
    });
    // re-listening on the same port shouldn't EADDRINUSE
    const promise = listenForCode({
      port: firstPort,
      expectedState: "ST",
      timeoutMs: 5000,
      onReady: (port) => void fire(port, "?code=Y&state=ST"),
    });
    await expect(promise).resolves.toBe("Y");
  });

  it("ignores requests to other paths", async () => {
    const promise = listenForCode({
      port: 0,
      expectedState: "ST",
      timeoutMs: 5000,
      onReady: async (port) => {
        await fetch(`http://127.0.0.1:${port}/favicon.ico`);
        await fire(port, "?code=Z&state=ST");
      },
    });
    await expect(promise).resolves.toBe("Z");
  });
});
