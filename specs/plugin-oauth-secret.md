# plugin-oauth-secret

> Extends [plugin-oauth](./plugin-oauth.md). Read that first for the base contract.

## Problem Statement

`dither plugin oauth` today is PKCE-only (RFC 7636). PKCE replaces a client secret with a verifier/challenge pair, which is the right choice for fully public clients (Spotify, Bluesky). But several providers we want to support — Stack Exchange, Reddit, GitHub classic OAuth apps, Notion — don't implement PKCE. They use RFC 6749 confidential auth-code: a `client_secret` posted to the token endpoint in place of `code_verifier`.

Two further mismatches break the current command against these providers:

- **Response format.** Stack Exchange's default token endpoint returns `application/x-www-form-urlencoded`, not JSON. Current `exchangeCode` calls `res.json()` and throws.
- **Field names.** Stack Exchange returns `expires` (seconds-until-expiry) instead of `expires_in`. The human-readable output silently prints `undefined`.
- **Missing refresh_token.** Some providers (SE default, GitHub classic) only return an `access_token`. The current output prints `refresh_token: undefined` rather than acknowledging absence.

Net effect: every non-PKCE OAuth provider needs the user to either bring their own PKCE helper (defeats the purpose) or skip the built-in command entirely.

## Solution

Add a `--client-secret` flag. Presence switches the command into confidential-client mode:

- Authorize URL drops `code_challenge` + `code_challenge_method`.
- Token POST drops `code_verifier`, adds `client_secret`.
- Token response is parsed by `Content-Type`: JSON → `JSON.parse`, anything else → `URLSearchParams`.
- `expires` is normalized to `expires_in`.
- Missing `refresh_token` prints a clear "(none — provider returned no refresh_token)" line instead of `undefined`.

Default behavior (no `--client-secret`) is byte-identical to today. Spotify, the only current PKCE consumer, doesn't notice.

Example for Stack Exchange:

```
dither plugin oauth \
  --client-id 12345 \
  --client-secret xxx \
  --auth-url https://stackoverflow.com/oauth \
  --token-url https://stackoverflow.com/oauth/access_token/json \
  --scopes no_expiry,private_info
```

## User Stories

1. As a user installing the Stack Exchange plugin, I want `dither plugin oauth --client-secret …` to run the confidential auth-code flow, so SE accepts my exchange.
2. As a user of a provider whose token endpoint returns form-urlencoded responses, I want the command to parse either format transparently, so I don't have to script a translation layer.
3. As a user of a provider whose token response uses `expires` instead of `expires_in`, I want the command to normalize the field, so the printed expiry isn't `undefined`.
4. As a user of a provider that doesn't issue refresh tokens (SE default, GitHub classic), I want a clear "(none returned)" indication instead of `refresh_token: undefined`, so I know whether to plan for re-auth.
5. As a current PKCE-only user (Spotify), I want zero behavior change when I don't pass `--client-secret`, so existing recipes don't regress.
6. As a scripter using `--json`, I want `refresh_token` to be `null` when absent rather than missing or `undefined`, so my JSON consumer has a deterministic shape.
7. As a future plugin author, I want the README example for each provider to make the PKCE-vs-secret choice explicit (one line per provider), so users don't pick the wrong mode.
8. As a future maintainer adding a third OAuth flow (device-code, etc.), I want today's mode switch to be a single boolean derived from one flag, so adding a third mode doesn't require a refactor.

## Implementation Decisions

**Flag.** `--client-secret <string>` (optional). When present, the command runs in confidential mode; when absent, PKCE mode (today's behavior). Mutually exclusive in practice — the spec does not attempt to support PKCE+secret simultaneously (Google's variant). Deferred.

**Authorize URL assembly.** The PKCE math module gains an `includePkce` toggle (derived from `clientSecret == null`). When false, `code_challenge` + `code_challenge_method` are omitted. `state` remains in both modes.

**Token POST.** Same toggle. When false, body omits `code_verifier` and adds `client_secret`. Otherwise unchanged.

**Token response parsing.** Inspect `Content-Type`:
- starts with `application/json` → `JSON.parse(text)`
- anything else → `Object.fromEntries(new URLSearchParams(text))`

A single normalization pass after parsing:
- if the result has `expires` and no `expires_in`, set `expires_in = Number(expires)` and delete `expires`.

Both branches reuse the existing non-2xx → throw-with-body-text logic.

**Output, default mode.**
- If `refresh_token` is missing or empty: print `(none — provider returned no refresh_token)` on stderr in place of the existing "✓ refresh_token" stdout line. The access token block still prints.
- Otherwise unchanged.

**Output, `--json` mode.** Existing object shape, plus:
- `refresh_token: null` when absent (instead of omitting the key).
- `expires_in: <number>` always set when the provider returned either field.

**Module changes.** Only `pkce.ts` and `commands/plugin-oauth.ts`. No new modules; no new files. `pkce.ts` stays named as-is (rename is mechanical and not user-visible).

**Future-proofing.** A future third mode (device-code, etc.) would be selected by its own flag (`--device-code`) — the boolean `includePkce` toggle is local to `pkce.ts` and not part of the public flag surface.

**Backwards compatibility.** No flag renames, no defaults changed. Adding `--client-secret` is purely additive.

## Testing Decisions

Test through the module's existing seams. No new modules → no new test files; extend `pkce.test.ts`.

**`buildAuthUrl` in secret mode.** Asserts `code_challenge` and `code_challenge_method` are absent. Other params unchanged.

**`exchangeCode` in secret mode.** Injects a fake `fetch`. Asserts the POST body contains `client_secret=…` and does not contain `code_verifier`.

**`exchangeCode` form-urlencoded response.** Fake fetch returns `Content-Type: application/x-www-form-urlencoded` with body `access_token=A&expires=3600`. Asserts the returned object has `access_token` and `expires_in: 3600`.

**`exchangeCode` JSON response with `expires` field.** Fake fetch returns JSON `{ access_token: "A", expires: 3600 }`. Asserts `expires_in: 3600` in the result.

**`exchangeCode` missing refresh_token.** Asserts the returned object has `refresh_token: undefined` (the type already permits it; just verify no exception).

The orchestrator (`commands/plugin-oauth.ts`) and the browser-opener remain untested per the precedent in [plugin-oauth](./plugin-oauth.md).

## Out of Scope

- Simultaneous PKCE + client_secret (Google's variant). Defer until a Google integration actually lands.
- Device-code flow, client_credentials, JWT-bearer, refresh_token grant, OIDC discovery. Same exclusions as v1.
- Provider presets / per-provider config. Same as v1.
- Renaming `pkce.ts` → `oauth.ts`. Mechanical; not user-visible. Bundle into an unrelated cleanup if ever.
- Auto-detecting whether a provider wants PKCE vs secret. The user (or plugin docs) picks.

## Further Notes

- Once landed, the same command covers: Spotify (PKCE), Bluesky (PKCE), Reddit classic (secret), Stack Exchange (secret), GitHub classic (secret), Notion (secret), Mastodon (secret). Roughly two-thirds of the `notes/plugin-*.md` backlog.
- Stack Exchange has an extra detail: their `key` parameter (not OAuth-related, used for per-app quota) is appended on API requests, not on the auth flow. It does not affect this command.
- SE's `/oauth/access_token/json` token-URL suffix is the JSON variant. Users who prefer URL-encoded responses can use `/oauth/access_token`; both work after this change. Document `…/json` as the recommended form in the SE plugin install instructions for human-readability of error responses.
- Estimated implementation size: ~25 LOC added in `pkce.ts`, ~10 LOC added in `commands/plugin-oauth.ts`, ~40 LOC of new tests. No new dependencies.
