// PKCE (RFC 7636) primitives + OAuth URL/body assembly.
//
// Pure functions, no I/O state. `fetch` is injectable in exchangeCode so
// tests don't hit the network. The whole thing is dep-free — node:crypto
// + global fetch.

import { createHash, randomBytes } from "node:crypto";

type Fetch = typeof fetch;

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(16).toString("base64url");
}

export interface AuthUrlOpts {
  authUrl: string;
  clientId: string;
  scopes: string[];
  redirectUri: string;
  challenge: string;
  state: string;
}

export function buildAuthUrl(opts: AuthUrlOpts): string {
  const u = new URL(opts.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("scope", opts.scopes.join(" "));
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  return u.toString();
}

export interface ExchangeOpts {
  tokenUrl: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  fetch?: Fetch;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export async function exchangeCode(opts: ExchangeOpts): Promise<TokenResponse> {
  const f = opts.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  const res = await f(opts.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token endpoint ${res.status}: ${text}`);
  }
  return (await res.json()) as TokenResponse;
}
