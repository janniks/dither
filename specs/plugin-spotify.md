# plugin-spotify

## Problem Statement

The user listens to a lot of music and podcasts on Spotify. Right now that activity vanishes — there's no local, searchable record of what they heard, and the lyrics / show-notes that gave each track meaning live behind apps and TOS-restricted APIs. They want a personal markdown archive of their listening, slotted into the dither library next to their other captures, so it surfaces in `dither search` alongside articles, threads, and transcripts.

## Solution

A dither plugin that polls Spotify's recently-played feed every 30 minutes and writes one markdown entry per newly-heard track or episode into the user's library.

- For songs, the body is the song's lyrics (LRCLIB first, AZLyrics fallback).
- For podcasts, the body is the Spotify-supplied episode description as markdown.
- Each entry is written **once**: re-plays of the same track or episode don't rewrite the file. `played_at` reflects first sighting only. Simple wins over accurate.

The user authorises the plugin via standard OAuth PKCE (refresh token pasted at install time; the helper page that produces that token is out of scope for this spec).

## User Stories

1. As a Spotify listener, I want my recently-heard tracks to land in my dither library as markdown, so that I can search my listening history the same way I search my articles.
2. As a lyrics reader, I want each song entry to contain the song's lyrics, so that the entry is content-rich rather than metadata-only and matches dither's "content over metadata" rule.
3. As a podcast listener, I want each heard episode to land as a markdown entry with the show-notes inside, so that I can grep episode descriptions and rediscover them.
4. As a privacy-minded user, I want to enable songs-only or podcasts-only mode via a single env, so that I'm not forced to capture data I don't want.
5. As a user with obscure music taste, I want LRCLIB's gaps to fall back to AZLyrics, so that more of my tracks come out with real lyrics instead of placeholders.
6. As an OAuth-savvy user, I want the plugin to use my client_id and refresh_token directly (no in-plugin browser flow), so that I can acquire the refresh_token via whatever PKCE helper I prefer and paste it in once.
7. As a daemon operator, I want every Spotify token refresh persisted to state, so that Spotify's refresh-token rotation doesn't silently brick the plugin after a week.
8. As a heavy listener, I want the plugin to skip tracks it has already promoted, so that the run is cheap (no Spotify call beyond recently-played, no lyrics lookup) and re-plays don't churn the library.
9. As a careful citizen of third-party services, I want the plugin to honour `Retry-After` on 429s and self-throttle AZLyrics scraping, so that I don't get rate-limited or IP-banned.
10. As a dither user worried about overreach, I want the plugin's net allowlist tightly constrained to the small set of hosts it actually needs, so that the install grant is reviewable.
11. As a returning user, I want a run that finds no new tracks to be a no-op (no entries, no API calls beyond the one mandatory poll), so that idle hours don't pile up disk writes.

## Implementation Decisions

**New plugin location.** `test.local/plugins/spotify/` with `plugin.ts`, `package.json` (manifest), `deno.json`.

**Manifest (`package.json` → `dither`).**

- `display_name`: "Spotify"
- `tagline`: short one-liner
- `schedule`: `*/30 * * * *`
- `collections`: `["spotify/songs", "spotify/podcasts"]`
- `net`: `["api.spotify.com", "accounts.spotify.com", "lrclib.net", "www.azlyrics.com", "search.azlyrics.com"]`
- `env`:
  - `SPOTIFY_CLIENT_ID` (required, no default) — Spotify dev-app client id
  - `SPOTIFY_REFRESH_TOKEN` (required, no default) — long-lived refresh token from PKCE
  - `MODES` (default `songs,podcasts`) — comma-separated subset of `songs`, `podcasts`
- `files`: none

**Modes.** Parsed from `MODES` env. Unknown tokens are warned-and-ignored. Empty MODES disables the plugin's run (it returns early after token refresh — no harm). Each mode is a discrete code path filtered out of the same recently-played fetch.

**Auth module.** Owns the OAuth refresh dance.

- Input: `client_id`, `refresh_token` (from state if present, else from env), state ref.
- Output: an `access_token` valid for the run.
- POSTs to `accounts.spotify.com/api/token` with `grant_type=refresh_token`.
- If Spotify returns a new `refresh_token` in the response, write it to `state.refresh_token` and flush before any other network work.
- 401 / `invalid_grant` from refresh ⇒ throw with a clear message. Run fails; user must reinstall.

**Spotify client.** Single thin wrapper.

- `GET /me/player/recently-played?limit=50`.
- Sends `Authorization: Bearer <access_token>`.
- 429 with `Retry-After` ⇒ call `reschedule({ afterMs: retryAfter*1000, reason })` and exit cleanly.
- 5xx ⇒ throw (let the host count it as a failure and back off).

**Recently-played processing.**

- Response shape: `{ items: [{ played_at, track } | { played_at, episode? }] }`. The track object's `type` field disambiguates (`track` vs `episode`). The recently-played endpoint only returns plays of items the user owns/has access to.
- For each item: derive `id` (`track.id` or `episode.id`), `played_at` (from the event), `kind` (`track`/`episode`).
- Skip if `state.seen[id]` exists (no fetch, no write).
- Skip if the mode for that kind is disabled in MODES.
- Otherwise enqueue for body-generation + write.

**Lyrics module (songs).**

- Try LRCLIB: `GET https://lrclib.net/api/get?track_name=<title>&artist_name=<artist>&album_name=<album>&duration=<sec>`. 200 ⇒ use `plainLyrics` (preferred) or `syncedLyrics`. 404 ⇒ fall through.
- Try AZLyrics:
  - First request the search endpoint, find the first result whose URL matches `azlyrics.com/lyrics/<slug>/<slug>.html`.
  - Fetch that page, extract the lyrics from the unmarked `<div>` after the comment marker (`<!-- Usage of azlyrics.com content...`).
  - 1500ms self-throttle between AZLyrics requests within a single run.
  - Cloudflare 403 / HTML mismatch ⇒ treat as miss.
- Both miss ⇒ `null`. Body becomes a placeholder (`_Lyrics not found_`) + a small metadata table.
- Returns `{ body, source }` where source is `lrclib` / `azlyrics` / `none`.

**Podcast module.**

- Body is `episode.description` (which Spotify already serves as a string; not HTML in most cases — light markdown-ish normalisation only: collapse runs of whitespace, trim).
- No external lookups.

**Entry writer.**

- Songs: `spotify/songs`, filename `<track_id>.md`, frontmatter `{ id, title, artist, album, duration_ms, played_at, spotify_url, lyrics_source }`.
- Podcasts: `spotify/podcasts`, filename `<episode_id>.md`, frontmatter `{ id, title, show, played_at, duration_ms, spotify_url }`.
- After successful `writeEntry`, add `id` to `state.seen` and persist (batched once per run at the end — single state write — see below).

**State shape.**

```
{
  "refresh_token": string,             // canonical after first run
  "seen": { [id: string]: true }       // single flat object — both tracks and episodes; ids are unique across kinds in Spotify
}
```

- `seen` is written as an object (not array) so existence checks are O(1) and the on-disk JSON survives long use.
- The plugin currently does not prune `seen`. Even an extremely heavy listener (50k unique items) is well under 1MB JSON.

**Progress reporting.** Standard `progress({ message })` at:
- start ("refreshing access token")
- after recently-played fetch ("X new of 50 events")
- per-batch lyrics ("fetching lyrics N/M")
- before exit ("promoted X songs, Y episodes")

**Rate-limit + reschedule policy.**

- 429 from Spotify ⇒ `reschedule(retryAfter*1000)` and exit. Drop in-progress new ids so they retry next run.
- 429 from LRCLIB / AZLyrics ⇒ skip the specific lookup (treat as a lyrics miss), continue with the rest. Do not reschedule the whole run for a single miss.
- AZLyrics 403/Cloudflare ⇒ treat as a per-request miss; do not reschedule.

## Testing Decisions

A good test here is one that exercises the code without going to the network. None of the three external HTTP boundaries (Spotify, LRCLIB, AZLyrics) should be hit from CI. We don't try to test the plugin end-to-end against dither's host — the plugin host has its own integration tests already (`plugin-host.test.ts`).

What we test:

- **Lyrics module**: given a `fetch`-compatible mock, returns lyrics from LRCLIB happy path, falls through to AZLyrics on LRCLIB 404, returns `null` when both miss, parses AZLyrics HTML correctly (including its known comment-marker quirk).
- **Auth module**: given a mock fetch, persists a rotated refresh_token to state, leaves state alone when Spotify doesn't rotate, throws on `invalid_grant`.
- **Recently-played processing**: pure-function tests that given a fixed event list + state, produce the expected list of new ids + correctly filter by MODES.
- **Entry shape**: snapshot-ish test that a song event produces a frontmatter+body string with the expected fields.

Prior art: `hn-favorites` and `github-stars` are pure scripts with no tests; `imessage` has none either. Plugin-host integration tests live in the CLI package. We follow precedent — no co-located plugin tests in `test.local/plugins/spotify/`. Logic that warrants tests (lyrics fallback, auth rotation, recently-played filtering) lives in small `.ts` modules next to `plugin.ts`, exported as pure functions; tests are *.test.ts in the same dir, runnable via `deno test`.

The lyrics extractor for AZLyrics is the riskiest single function — give it the most coverage (real captured HTML fixtures committed under `test-fixtures/`).

## Out of Scope

- The hosted PKCE redirect page that produces a refresh_token from a code. Users acquire the refresh_token through whatever means they prefer for now; the plugin only accepts the final value.
- Privacy data dump (`endsong.json`) import. Deferred; would be a separate plugin.
- Lyrics for episodes / transcripts. Spotify doesn't expose them and there's no agreed third-party source.
- Saved tracks, saved albums, top items, playlists, followed shows. All metadata-only without an attached content artifact; not in this plugin.
- RSS show-notes enrichment for podcasts. Skipped to keep the net allowlist tight.
- iTunes Search lookup for `feed_url`. Skipped — body is Spotify's description; the show name is in frontmatter.
- A `MAX_ITEMS` knob. Recently-played already caps at 50; no further cap needed.
- Updating song entries on replay (last_played, play_count, plays[] array). Explicitly chosen: write once, never update.

## Further Notes

- Spotify's recently-played endpoint returns at most 50 events with no historical pagination — so first-run captures only the last 50 plays. This is a fundamental API constraint, not a bug.
- AZLyrics is in ToS gray territory for automated access. Accepting the risk for a single-user personal-archive use case. If it breaks, lyrics quietly degrade to placeholders; no other failure mode.
- LRCLIB has no published rate limit; we don't self-throttle. If it ever 429s we treat that request as a miss and keep going.
- Spotify rotates refresh tokens aggressively. The rotation-to-state write happens *before* any other network work each run so a crash mid-run doesn't lose the new token.
