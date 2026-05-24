import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildAuthUrl, exchangeCode, generatePkce, generateState } from "./pkce";

describe("generatePkce", () => {
  it("returns base64url verifier (43 chars from 32 random bytes)", () => {
    const { verifier } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("challenge is base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("RFC 7636 Appendix B test vector", () => {
    // The vector is for the verifier→challenge transform only; we don't
    // generate the verifier here, just confirm the hash matches.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("subsequent calls produce different verifiers", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("generateState", () => {
  it("returns base64url state from 16 random bytes", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("buildAuthUrl", () => {
  it("assembles every required OAuth param", () => {
    const url = buildAuthUrl({
      authUrl: "https://accounts.spotify.com/authorize",
      clientId: "abc",
      scopes: ["user-read-recently-played", "playlist-read-private"],
      redirectUri: "http://127.0.0.1:8888/callback",
      challenge: "CHAL",
      state: "STATE",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("abc");
    expect(u.searchParams.get("scope")).toBe("user-read-recently-played playlist-read-private");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8888/callback");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("STATE");
  });

  it("preserves existing query params on the auth URL", () => {
    const url = buildAuthUrl({
      authUrl: "https://example.com/authorize?show_dialog=true",
      clientId: "abc",
      scopes: ["s"],
      redirectUri: "http://127.0.0.1:8888/callback",
      challenge: "CHAL",
      state: "STATE",
    });
    const u = new URL(url);
    expect(u.searchParams.get("show_dialog")).toBe("true");
    expect(u.searchParams.get("client_id")).toBe("abc");
  });

  it("omits code_challenge in confidential-client mode (no challenge arg)", () => {
    const url = buildAuthUrl({
      authUrl: "https://stackoverflow.com/oauth",
      clientId: "12345",
      scopes: ["no_expiry"],
      redirectUri: "http://127.0.0.1:8888/callback",
      state: "STATE",
    });
    const u = new URL(url);
    expect(u.searchParams.has("code_challenge")).toBe(false);
    expect(u.searchParams.has("code_challenge_method")).toBe(false);
    expect(u.searchParams.get("state")).toBe("STATE");
  });
});

describe("exchangeCode", () => {
  it("posts the right form body and returns tokens", async () => {
    let captured: { url: string; method: string; body: string } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = {
        url: String(url),
        method: String(init?.method),
        body: String(init?.body),
      };
      return new Response(
        JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "s" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const r = await exchangeCode({
      tokenUrl: "https://accounts.spotify.com/api/token",
      clientId: "abc",
      code: "CODE",
      verifier: "VER",
      redirectUri: "http://127.0.0.1:8888/callback",
      fetch: fakeFetch,
    });
    expect(r).toEqual({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "s" });
    expect(captured!.url).toBe("https://accounts.spotify.com/api/token");
    expect(captured!.method).toBe("POST");
    const body = new URLSearchParams(captured!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:8888/callback");
    expect(body.get("client_id")).toBe("abc");
    expect(body.get("code_verifier")).toBe("VER");
  });

  it("posts client_secret (and not code_verifier) in confidential mode", async () => {
    let body = "";
    const fakeFetch: typeof fetch = async (_url, init) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({ access_token: "AT", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await exchangeCode({
      tokenUrl: "https://stackoverflow.com/oauth/access_token/json",
      clientId: "12345",
      clientSecret: "sssh",
      code: "CODE",
      redirectUri: "http://127.0.0.1:8888/callback",
      fetch: fakeFetch,
    });
    const b = new URLSearchParams(body);
    expect(b.get("client_secret")).toBe("sssh");
    expect(b.has("code_verifier")).toBe(false);
    expect(b.get("grant_type")).toBe("authorization_code");
  });

  it("parses form-urlencoded token responses", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("access_token=AT&expires=3600&scope=read", {
        status: 200,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    const r = await exchangeCode({
      tokenUrl: "https://stackoverflow.com/oauth/access_token",
      clientId: "12345",
      clientSecret: "sssh",
      code: "CODE",
      redirectUri: "http://127.0.0.1:8888/callback",
      fetch: fakeFetch,
    });
    expect(r).toEqual({ access_token: "AT", expires_in: 3600, scope: "read" });
  });

  it("normalizes `expires` to `expires_in` from a JSON response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: "AT", expires: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const r = await exchangeCode({
      tokenUrl: "https://x/token",
      clientId: "c",
      clientSecret: "s",
      code: "CODE",
      redirectUri: "r",
      fetch: fakeFetch,
    });
    expect(r.expires_in).toBe(7200);
  });

  it("returns refresh_token as undefined when the provider omits it", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const r = await exchangeCode({
      tokenUrl: "https://x/token",
      clientId: "c",
      clientSecret: "s",
      code: "CODE",
      redirectUri: "r",
      fetch: fakeFetch,
    });
    expect(r.refresh_token).toBeUndefined();
    expect(r.access_token).toBe("AT");
  });

  it("throws with the response body on non-2xx", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(`{"error":"invalid_grant"}`, { status: 400 });
    await expect(
      exchangeCode({
        tokenUrl: "https://x/token",
        clientId: "c",
        code: "bad",
        verifier: "v",
        redirectUri: "r",
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/400/);
    await expect(
      exchangeCode({
        tokenUrl: "https://x/token",
        clientId: "c",
        code: "bad",
        verifier: "v",
        redirectUri: "r",
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
