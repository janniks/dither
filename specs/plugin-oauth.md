# plugin-oauth

## Problem Statement

Several future plugins (Spotify, Reddit, Bluesky, Notion, GitHub, Google) need OAuth refresh tokens at install time. Today there's no help getting one — the user has to find or write a PKCE helper on their own, paste a code into a curl recipe, decode the response, and copy the refresh_token into the plugin install prompt. Every OAuth-based plugin re-poses the same setup hurdle.

## Solution

A new subcommand `dither plugin oauth` that runs the PKCE authorization-code flow for any provider the user supplies URLs for. The user invokes it once per plugin install:

```
dither plugin oauth \
  --client-id <id> \
  --auth-url https://accounts.spotify.com/authorize \
  --token-url https://accounts.spotify.com/api/token \
  --scopes user-read-recently-played
```

The command spins up a local callback server, opens the user's browser to the authorize URL, captures the redirect, exchanges the code for tokens, and prints the refresh token. The user pastes it into the next `dither plugin install` prompt.

No provider knowledge ships with dither — the tool stays fully generic and reusable for any PKCE-capable OAuth provider, present or future.

## User Stories

1. As a plugin author, I want a built-in command that runs PKCE for any provider, so that my plugin's setup instructions can be `dither plugin oauth ...; dither plugin install ...` instead of "go find a PKCE helper".
2. As a user installing my first OAuth-based plugin, I want one command that does the whole authorize-and-exchange dance, so that I don't have to learn PKCE or write throwaway scripts.
3. As a user on a fresh machine, I want the command to auto-open my browser to the authorize URL, so that the only thing I do is click "Authorize" in the provider's UI.
4. As an SSH or headless user, I want the authorize URL printed in addition to the browser-open attempt, so that I can copy it to a browser on a different device.
5. As a scripter, I want a `--json` mode that prints `{ refresh_token, access_token, expires_in, scope }` to stdout, so that I can pipe the result into other tools without parsing human-friendly output.
6. As a user with port 8888 already in use, I want to override the local server port via `--port`, so that I'm not blocked by an unrelated process.
7. As a user who walked away mid-flow, I want a sensible default timeout, so that the dither process exits cleanly instead of hanging indefinitely.
8. As a user expecting to register a redirect URI in my provider dashboard, I want the command to print the redirect URI it will use, so that I know exactly what to paste into the dashboard before I run the authorize.
9. As a user whose state was mismatched (CSRF attempt or browser oddity), I want a clear error rather than a silent half-completed flow, so that I retry with a clean state.
10. As a developer of future dither features, I want this implemented as small dep-free modules over `node:crypto` + `node:http` + global `fetch`, so that no new third-party dependency is added.
11. As a user without `oauth` installed in PATH (Windows), I want the browser-open code to use `start` / `xdg-open` / `open` based on platform, so that the command works everywhere Node runs.
12. As a future maintainer adding interactive prompts, I want missing-required-flag behaviour to be the only code path that changes, so that flag users see no regression when prompts arrive.

## Implementation Decisions

**Subcommand placement.** Registered as `oauth` inside the existing `pluginCommand.subCommands` map. Appears in `dither plugin --help` like every other subcommand; not advertised in the README until the first OAuth-using plugin ships, but not actively hidden.

**Required flags (citty `required: true`).**
- `--client-id` — the OAuth app's client_id (no secret needed under PKCE).
- `--auth-url` — provider's authorize endpoint.
- `--token-url` — provider's token endpoint.
- `--scopes` — comma-separated list. Joined with spaces on the wire (OAuth-spec format) by the command before sending.

**Optional flags.**
- `--port <n>` (default `8888`) — port for the local callback server.
- `--timeout <sec>` (default `300`) — abort the listener if no callback arrives.
- `--no-open` (boolean) — suppress automatic browser open; the URL is still printed.
- `--json` (boolean) — machine-readable stdout instead of `confirm()`-style human display.

**Future-proofing for prompts.** Required-flag absence today produces citty's default required-argument error. A later version may swap that for interactive prompts; the flag interface stays unchanged so scripts continue to work.

**Redirect URI is derived.** Always `http://127.0.0.1:<port>/callback`. Printed prominently before the authorize URL so the user knows what to register in their provider dashboard.

**Modules.**
- A pure OAuth-math module owns PKCE primitives and URL/body assembly: `generatePkce`, `buildAuthUrl`, `exchangeCode`. Fetch is injectable for tests.
- A listener module owns the local callback server lifecycle: takes port, expected state, and timeout; resolves with the captured `code` or rejects on state mismatch / provider `error=` param / timeout. Server always closes before the promise settles.
- A 5-line cross-platform browser-opener module dispatches to `open` (macOS), `xdg-open` (Linux), or `start` (Windows) via `node:child_process`.
- A citty subcommand module orchestrates: parse argv → derive redirect URI → generate PKCE → start listener → open browser → await code → exchange → print. Wired into `pluginCommand.subCommands`.

**Concurrency.** Listener starts before browser opens to avoid a race where the user is faster than the server.

**Output (default).**
- Print derived redirect URI and authorize URL before opening browser.
- After exchange: `confirm()`-style "✓ Refresh token: …" and "✓ Access token: …" via `prompt.ts`. Refresh token gets its own line for easy double-click-select.

**Output (`--json`).** Single line of `JSON.stringify({ refresh_token, access_token, expires_in, scope })` to stdout. Progress / informational text routed to stderr so stdout stays clean for piping.

**Dependencies.** Zero new packages. Uses `node:crypto` (randomBytes + sha256 + base64url), `node:http` (createServer), `node:child_process` (spawn for browser), and global `fetch`.

**Error handling.**
- Provider returns `?error=access_denied` (or any error param) → listener rejects with the provider's error string.
- Local server times out → reject with a clear "no callback in <N>s" message.
- State param mismatch → reject with a "state mismatch — possible CSRF, retry" message.
- Token endpoint returns non-2xx → exit with the response body in the error.

**Citty integration.** Subcommand defined via `defineCommand` like every existing one in `packages/cli/src/commands/`; registered in the existing `pluginCommand.subCommands` map at the same site as `install`, `run`, `runs`, `list`, `remove`.

## Testing Decisions

A good test exercises the module's external behaviour, not its internals. Fetch is injectable everywhere it appears so tests don't go to the network.

**`pkce` module.**
- Verifier/challenge math against RFC 7636 test vectors (the spec ships them).
- `buildAuthUrl` assembles every required OAuth param in the URL.
- `exchangeCode` posts the right form body shape and surfaces non-2xx token-endpoint errors with the body text.

**`listen` module.**
- Real `http.Server` on a random port (`port: 0` then `address()`), fired against with `fetch('http://127.0.0.1:<actual>/callback?code=X&state=…')`. Assert captured code.
- Same flow with mismatched state → rejects.
- Same flow with `?error=access_denied` → rejects with the error.
- Timeout case → rejects after the configured timeout, server cleaned up.

**`commands/plugin-oauth` and `open-browser`** have no direct tests. Orchestrator is glue; browser-open is a single `spawn` call. Matches the precedent that `commands/plugin.ts` itself has no direct unit tests, only its called modules do.

## Out of Scope

- Provider presets (built-in JSON, user-supplied `~/.dither/oauth-presets.json`, or community plugins). Explicitly deferred until there's a real second user.
- Interactive prompts on missing required flags. Possible follow-up; flag interface designed not to regress when added.
- OAuth flows other than PKCE (device-code, classic auth-code with secret, client-credentials). PKCE-only is enough for every modern user-context provider we're likely to integrate.
- Automatic plugin-install chaining (running `plugin install` immediately after `oauth` with the refresh_token pre-filled). Possible follow-up; for v1 the user pastes manually.
- OIDC discovery (`.well-known/openid-configuration`). Most OAuth providers don't expose it; we keep the explicit URL contract.
- Persisting tokens anywhere on disk. The command is one-shot: print, exit. Storage is the install flow's job.
- Token refresh after install. Plugins refresh on their own using the refresh_token in their env.

## Further Notes

- The redirect URI is hard-coded path `/callback`. Providers like Spotify accept arbitrary paths under `http://127.0.0.1` after their post-2025 redirect URI tightening, so this is fine and reads obviously to humans.
- `state` is 16 random bytes base64url-encoded, generated per invocation. CSRF protection is the only thing this prevents in practice (no production redirect URI), but it's spec-mandated and cheap.
- Estimated implementation size: ~180 LOC production + ~100 LOC tests. No new `package.json` entries.
