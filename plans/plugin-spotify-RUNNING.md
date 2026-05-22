# Plan: Spotify plugin

> Source spec: `specs/plugin-spotify.md`

## Architectural decisions

- **Plugin location**: `test.local/plugins/spotify/`
- **Manifest env**: `SPOTIFY_CLIENT_ID`, `SPOTIFY_REFRESH_TOKEN`, `MODES` (default `songs,podcasts`)
- **Collections**: `spotify/songs`, `spotify/podcasts`
- **Net allowlist**: `api.spotify.com`, `accounts.spotify.com`, `lrclib.net`, `www.azlyrics.com`, `search.azlyrics.com`
- **Schedule**: `*/30 * * * *`
- **State shape**: `{ refresh_token: string, seen: { [id]: true } }`
- **Module split** (small files alongside `plugin.ts`, each with `.test.ts`):
  - `auth.ts` — refresh-token grant, rotation handling
  - `spotify.ts` — recently-played fetch, 429 → reschedule
  - `process.ts` — filter events by MODES + seen, classify track/episode
  - `lyrics.ts` — LRCLIB → AZLyrics fallback
  - `entry.ts` — frontmatter + body shaping
- **Test strategy**: pure-function modules with `fetch` injected as a param; AZLyrics parser tested against committed HTML fixtures. No live network in tests. No tests for the top-level `plugin.ts` orchestrator (matches `hn-favorites`/`github-stars`).

---

## Phase 1: Skeleton + auth + read-only fetch

**User stories**: 6, 7, 9 (the Spotify slice)

Plugin installs cleanly, refreshes an access token, fetches recently-played, prints a one-line summary via `progress()`, persists any rotated refresh_token to state. No entries written yet. Handles 429 from Spotify with `reschedule`.

**Acceptance:**
- [x] Plugin dir + manifest + `deno.json` + `plugin.ts` exist
- [x] Manifest declares the three env vars + correct net allowlist + collections + schedule
- [x] `auth.ts` exchanges refresh_token → access_token; persists rotated refresh_token to state before any other work
- [x] `auth.ts` throws on `invalid_grant` with a clear message
- [x] `spotify.ts` fetches `me/player/recently-played?limit=50` and returns the parsed events
- [x] `spotify.ts` calls `reschedule()` + exits cleanly on 429 with `Retry-After`
- [x] `auth.test.ts` covers happy path, rotation persistence, invalid_grant
- [x] `spotify.test.ts` covers happy path, 429 handling

---

## Phase 2: Write-once entries (no lyrics yet)

**User stories**: 1, 3, 4, 8, 11

End-to-end: a run finds new tracks/episodes in recently-played, writes one entry per id, never rewrites. MODES gates which kinds are written. Songs get a placeholder body + metadata table. Episodes get Spotify's `description` field. Seen-set persists to state.

**Acceptance:**
- [x] `process.ts` filters events by MODES + seen-state; returns the list of newly-promotable items classified as `track` / `episode`
- [x] `entry.ts` shapes a song entry (placeholder body + metadata) with the agreed frontmatter
- [x] `entry.ts` shapes an episode entry (Spotify description body) with the agreed frontmatter
- [x] Top-level plugin wires the loop: refresh → fetch → process → write → seen.add → state-flush at end
- [x] Empty MODES is a clean no-op after the token refresh
- [x] `process.test.ts` covers MODES gating + seen dedup
- [x] `entry.test.ts` covers song + episode body/frontmatter shape

---

## Phase 3: Lyrics enrichment (LRCLIB)

**User stories**: 2

When the song is on LRCLIB, the entry body is the lyrics instead of the placeholder; `lyrics_source: lrclib` recorded in frontmatter. Misses still produce the placeholder entry.

**Acceptance:**
- [ ] `lyrics.ts` exposes a `fetchLyrics({ title, artist, album, durationSec, fetch })` returning `{ body, source }`
- [ ] Wires LRCLIB GET with all four query params
- [ ] 200 with `plainLyrics` ⇒ returns lyrics; `lyrics_source: lrclib`
- [ ] 404 ⇒ returns `{ body: null, source: 'none' }` for now (AZLyrics added phase 4)
- [ ] Entry writer uses lyrics result when non-null; falls back to placeholder otherwise
- [ ] `lyrics.test.ts` covers LRCLIB hit + miss with injected fetch

---

## Phase 4: AZLyrics fallback

**User stories**: 5, 9, 10

On LRCLIB miss, plugin queries AZLyrics search → fetches the first matching lyrics page → extracts lyrics via the known comment-marker pattern. 1500ms self-throttle between requests. Cloudflare 403 / no-match treated as miss.

**Acceptance:**
- [ ] `lyrics.ts` adds the AZLyrics fallback path after LRCLIB 404
- [ ] Search endpoint hit, first matching `azlyrics.com/lyrics/...` URL chosen
- [ ] HTML parser extracts the lyrics div after the comment marker
- [ ] 1500ms throttle between AZLyrics requests within one run
- [ ] 403 / parse failure ⇒ falls through cleanly to `source: 'none'`
- [ ] `lyrics.test.ts` covers AZLyrics success (with committed HTML fixture), search-miss, parse-failure
- [ ] `lyrics_source: azlyrics` recorded in frontmatter on success

---

## Phase log

When starting implementation, this file is named `./plans/plugin-spotify-RUNNING.md`. Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. Stage and commit only that phase's changes after finishing, then continue to the next phase. Append a row below after every phase. When all phases complete, rename back to `./plans/plugin-spotify.md`.

| Commit | Summary |
|--------|---------|
| 72b58a7 | Phase 1 — manifest, deno.json, auth + recently-played modules with tests (9/9 pass), plugin orchestrator skeleton. Test.local is gitignored so the plugin code itself doesn't appear in the commit (matches existing plugin convention). |
