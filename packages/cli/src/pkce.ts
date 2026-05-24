// OAuth 2.0 auth-code primitives — PKCE (RFC 7636) and confidential
// (RFC 6749). One module owns both; the mode is selected per call.
//
// Pure functions, no I/O state. `fetch` is injectable in exchangeCode so
// tests don't hit the network. Dep-free — node:crypto + global fetch.

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
  state: string;
  /** Omit for confidential-client (client_secret) flows. */
  challenge?: string;
}

export function buildAuthUrl(opts: AuthUrlOpts): string {
  const u = new URL(opts.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("scope", opts.scopes.join(" "));
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  if (opts.challenge) {
    u.searchParams.set("code_challenge", opts.challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  return u.toString();
}

export interface ExchangeOpts {
  tokenUrl: string;
  clientId: string;
  code: string;
  redirectUri: string;
  /** PKCE verifier. Pass for public clients; omit when using clientSecret. */
  verifier?: string;
  /** Client secret. Pass for confidential clients; omit when using verifier. */
  clientSecret?: string;
  fetch?: Fetch;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
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
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
  if (opts.verifier) body.set("code_verifier", opts.verifier);
  const res = await f(opts.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${text}`);
  return normalize(parseTokenBody(res.headers.get("content-type"), text));
}

function parseTokenBody(contentType: string | null, text: string): Record<string, unknown> {
  if (contentType && contentType.includes("application/json")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return Object.fromEntries(new URLSearchParams(text)) as Record<string, unknown>;
}

// Stack Exchange returns `expires` (seconds) instead of `expires_in`.
// URLSearchParams-derived values arrive as strings; coerce expiry to number.
function normalize(raw: Record<string, unknown>): TokenResponse {
  const expires = raw.expires_in ?? raw.expires;
  const out: TokenResponse = { access_token: String(raw.access_token) };
  if (expires !== undefined) out.expires_in = Number(expires);
  if (raw.refresh_token) out.refresh_token = String(raw.refresh_token);
  if (raw.scope) out.scope = String(raw.scope);
  if (raw.token_type) out.token_type = String(raw.token_type);
  return out;
}
