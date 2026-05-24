# Plan: plugin-oauth-secret

> Source spec: `specs/plugin-oauth-secret.md`

## Architectural decisions

- **Subcommand:** stays `dither plugin oauth` — flag-driven mode switch, no new subcommand.
- **New flag:** `--client-secret <string>`, optional. Presence selects confidential auth-code mode.
- **Toggle locality:** boolean derived inside `pkce.ts` from `clientSecret == null`. Not part of the public flag surface.
- **Authorize URL:** secret mode drops `code_challenge` + `code_challenge_method`; `state` stays in both modes.
- **Token POST:** secret mode drops `code_verifier`, adds `client_secret`. PKCE mode unchanged.
- **Token response parsing:** content-type sniffing. `application/json` → `JSON.parse`; anything else → `URLSearchParams`.
- **Field normalization:** `expires` (numeric seconds, used by Stack Exchange) → `expires_in`. Single pass after parsing.
- **Missing refresh_token:** human mode prints "(none returned)" to stderr; `--json` emits `refresh_token: null`.
- **Backwards compat:** zero behavior change when `--client-secret` is omitted. Spotify PKCE flow unaffected.
- **No new modules.** All changes confined to `pkce.ts` and `commands/plugin-oauth.ts`. `pkce.ts` rename deferred.
- **Out of scope:** PKCE+secret simultaneously (Google's variant), device-code, client_credentials, OIDC, provider presets.

---

## Phase 1: PKCE module gains confidential mode + flexible response parsing

**User stories:** 1, 2, 3, 5 (no regression).

End-to-end behavior this slice delivers:

- `buildAuthUrl` accepts a new `pkce?: { challenge: string }` shape. When absent, the URL omits `code_challenge` + `code_challenge_method`.
- `exchangeCode` accepts `clientSecret?: string` and `verifier?: string`. When secret present, body posts `client_secret` instead of `code_verifier`.
- `exchangeCode` parses both JSON and `application/x-www-form-urlencoded` token responses.
- `expires` is normalized to `expires_in` in the returned object.
- Existing PKCE call sites are unchanged on the wire (default behavior identical).

**Acceptance:**
- [x] `buildAuthUrl` without a challenge argument produces a URL with no `code_challenge`.
- [x] `exchangeCode` with `clientSecret` posts `client_secret` and no `code_verifier`.
- [x] `exchangeCode` parses a form-urlencoded token response into the same `TokenResponse` shape.
- [x] `exchangeCode` normalizes a response field named `expires` into `expires_in`.
- [x] Existing tests still pass (PKCE happy-path + non-2xx error path).
- [x] No call-site changes in the orchestrator yet.

---

## Phase 2: CLI wiring + missing refresh_token handling

**User stories:** 1, 4, 6 (and 7 — install docs).

End-to-end behavior this slice delivers:

- New `--client-secret` flag on `dither plugin oauth`.
- When present, PKCE generation is skipped; authorize URL omits PKCE params; exchange sends `client_secret`.
- When the token response has no `refresh_token`: human mode prints "(none — provider returned no refresh_token)" on stderr in place of the existing refresh-token line; `--json` mode emits `refresh_token: null`.
- After this phase, the full Stack Exchange recipe in the spec works end-to-end.

**Acceptance:**
- [x] `--client-secret` flag exists, optional, documented in the subcommand help text.
- [x] When `--client-secret` is set, the authorize URL printed to stderr contains no `code_challenge`.
- [x] When `--client-secret` is set, the token POST body contains `client_secret` and no `code_verifier`. (Verified by orchestrator's call shape, not a new test — covered by phase 1 unit tests.)
- [x] Missing `refresh_token` → human output prints "(none …)" instead of "✓ refresh_token:\nundefined".
- [x] Missing `refresh_token` + `--json` → output is valid JSON with `refresh_token: null`.
- [x] Behavior with no `--client-secret` is byte-identical to today's PKCE flow.

---

## Phase log

When starting implementation, rename this file to `./plans/plugin-oauth-secret-RUNNING.md` (already done). Each phase stages and commits only its own files. When all phases complete, rename back to `./plans/plugin-oauth-secret.md`.

| commit | summary |
|--------|---------|
| 812c2c1 | spec+plan: confidential auth-code mode for `dither plugin oauth` |
| 4a15eca | Phase 1: pkce.ts gains confidential mode + flexible response parsing + `expires` normalization |
| 86a374d | Phase 2: orchestrator wires `--client-secret`; missing refresh_token gracefully handled |
