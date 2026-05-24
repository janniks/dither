# Plan: plugin-oauth

> Source spec: `specs/plugin-oauth.md`

## Architectural decisions

- **Subcommand**: `dither plugin oauth`, registered in the existing `pluginCommand.subCommands` map (`packages/cli/src/commands/plugin.ts`).
- **Modules** (new, under `packages/cli/src/`):
  - `pkce.ts` — pure OAuth math: `generatePkce`, `buildAuthUrl`, `exchangeCode`. `fetch` injectable for tests.
  - `listen.ts` — local callback server lifecycle. `listenForCode({ port, expectedState, timeoutMs })`.
  - `open-browser.ts` — 5-line cross-platform `spawn`.
  - `commands/plugin-oauth.ts` — citty subcommand orchestrator.
- **Dependencies**: zero new. `node:crypto`, `node:http`, `node:child_process`, global `fetch`.
- **Output**: defaults to `confirm()` from `prompt.ts`; `--json` toggles a single-line JSON to stdout (informational text routed to stderr).
- **Redirect URI** is always `http://127.0.0.1:<port>/callback`, derived from `--port` (default 8888).
- **No new third-party deps. No persistence.** Print, exit.

---

## Phase 1: PKCE math + auth URL

**User stories**: 10, 12

Deliver `pkce.ts` with PKCE-primitive generation and authorize-URL assembly. Pure functions; tested against RFC 7636 vectors and explicit param assertions. No orchestrator yet, nothing user-visible.

**Acceptance:**
- [x] `generatePkce()` returns a base64url verifier and an S256 base64url challenge derived from it
- [x] `buildAuthUrl(opts)` emits a URL with `response_type=code`, `client_id`, `scope` (space-joined), `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state`
- [x] Tests cover the RFC 7636 test vector (`dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` ↔ known challenge) + URL assembly for a sample provider

---

## Phase 2: Listener + browser open

**User stories**: 3, 4, 7, 9, 11

Deliver `listen.ts` and `open-browser.ts`. Listener resolves with code on `/callback?code=…&state=…`, rejects on state mismatch / `?error=…` / timeout. Server cleans itself up. Browser-open is platform-dispatched `spawn` with no tests. No orchestrator yet.

**Acceptance:**
- [x] `listenForCode` resolves with `code` when a valid request hits `/callback`
- [x] Rejects when `state` query param mismatches `expectedState`
- [x] Rejects when `?error=...` is present, with the error string in the message
- [x] Rejects after `timeoutMs` with a clear "no callback in <N>s" message; server closed
- [x] Server bound to `127.0.0.1` only (not `0.0.0.0`)
- [x] Tests use `port: 0` to grab a free port; no flaky fixed-port collisions
- [x] `open-browser.ts` dispatches `open`/`xdg-open`/`start` based on `process.platform`

---

## Phase 3: Subcommand wired end-to-end (default human output)

**User stories**: 1, 2, 6, 8

Add `exchangeCode` to `pkce.ts` (with test). Build the citty subcommand at `commands/plugin-oauth.ts`, wire into `pluginCommand.subCommands`. End-to-end flow: parse flags → derive redirect URI → generate PKCE → start listener → open browser → await code → exchange → print tokens via `confirm()`. Demoable against a real provider (Spotify).

**Acceptance:**
- [ ] `exchangeCode` POSTs the right form body (`grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`) and returns parsed JSON
- [ ] `exchangeCode` throws with the response body when the token endpoint returns non-2xx
- [ ] `dither plugin oauth` shows up in `dither plugin --help`
- [ ] Required flags (`--client-id`, `--auth-url`, `--token-url`, `--scopes`) error out cleanly when missing (citty default behaviour is fine)
- [ ] Optional `--port` flag works; default 8888
- [ ] Stderr prints the derived redirect URI and the authorize URL before browser opens
- [ ] On success, stderr prints `✓ Refresh token: …` and `✓ Access token: …` via `confirm()`
- [ ] Browser auto-opens by default; URL also printed so the SSH/headless path works without it
- [ ] Tests on `exchangeCode`: happy path + error path with mocked fetch

---

## Phase 4: JSON output + --no-open + timeout flag + error polish

**User stories**: 5, 7

Wire the remaining flags: `--json`, `--no-open`, `--timeout`. Tighten error surfacing for the three rejection paths from phase 2. No new modules.

**Acceptance:**
- [ ] `--json` prints `{ refresh_token, access_token, expires_in, scope }` as one line to stdout; all informational text goes to stderr
- [ ] `--no-open` suppresses browser spawn; authorize URL still printed
- [ ] `--timeout <sec>` flag accepted; default 300
- [ ] State mismatch / provider error / timeout each surface a single clear stderr line and exit non-zero
- [ ] Reading stdout under `--json` produces parseable JSON (no contamination from progress text)

---

## Phase log

When starting implementation, this file is named `./plans/plugin-oauth-RUNNING.md`. Tick each phase's acceptance as satisfied, commit per phase, append a row below. When all phases complete, rename back to `./plans/plugin-oauth.md`.

| Commit | Summary |
|--------|---------|
| e80da00 | Phase 1 — pkce.ts (generate, buildAuthUrl, exchangeCode) + tests against RFC 7636 vector. 9/9 pass. |
