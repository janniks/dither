# Plan: twitter-hydrate

> Source spec: `specs/twitter-hydrate.md`

## Architectural decisions

- **Grants**: manifest `collections` → `create`; new sibling `edit` (flat
  glob lists, same pattern grammar). Grants file mirrors both. No compat
  code — clean break, all in-repo manifests migrate in phase 1.
- **Promote decision table**: same source → overwrite; diff source +
  `edit` covers → overwrite; diff source, no `edit` → skip + journal
  warn, never fail. Skips emit no watch events.
- **Prompt policy**: interactive install surfaces only manifest-requested
  grants; extras via `--create`/`--edit` flags.
- **API boundary**: twitterapi.io, `X-API-Key` header, batch 100 ids,
  `/twitter/tweets` (tweets) + user batch endpoint (profiles).
- **Idempotency**: `hydrated_at` frontmatter is the ledger; `hydrate:
  gone` terminal for confirmed-missing ids (successful response, absent
  id). Entry filename = tweet/account id.
- **Prod safety**: temp-dir tests only; capped smoke slice before corpus
  writes; takeout zip remains recovery source.

---

## Phase 1: Grant vocabulary — create/edit

**User stories**: 13, 14

Manifest schema accepts `create` + `edit` (rejects `collections` with a
hint), planner/prompts/grants file/status carry both, `--create`/`--edit`
flags on install+run, all test.local manifests migrated.

**Acceptance:**
- [ ] `create`/`edit` parse + validate with grant-pattern grammar
- [ ] `collections` key → parse error naming the rename
- [ ] interactive install prompts `edit` only when manifest declares it
- [ ] `--create`/`--edit` flags override/extend like `--allow-net`
- [ ] all 13 test.local manifests migrated; tests green

## Phase 2: Promote skip/edit branch

**User stories**: 12, 13, 14

Promotion enforces the decision table; skipped files journaled
(`{kind: "skipped"}` + warn) and counted in the result, run stays ok.

**Acceptance:**
- [ ] cross-source overwrite allowed with `edit` grant
- [ ] cross-source without `edit` → file skipped, run ok
- [ ] skip journaled + surfaced in result counts
- [ ] same-source overwrite unchanged; tests cover all branches

## Phase 3: twitter-hydrate — tweets

**User stories**: 1–6, 9–12, 15

Plugin hydrates likes + bookmarks in place: full text, t.co resolution
(body + urls frontmatter), quote blockquote, engagement frontmatter,
hydrated/gone stamps. Watch + backfill + MAX_ITEMS. Smoke: MAX_ITEMS=10
against real library, eyeball entries.

**Acceptance:**
- [ ] api client: ok/absent/failed outcomes distinguished (tests)
- [ ] render pure tests: t.co, quotes, urls union, gone, engagement
- [ ] hydrated_at skip makes watch/backfill idempotent
- [ ] smoke slice of 10 verified in library; index updated

## Phase 4: Profiles + import trim

**User stories**: 7, 8

Follows/followers hydrate to bio-body profile docs; website + bio URLs
into `urls`. twitter-import: create-only manifest, blocks/mutes deleted,
follows body empty.

**Acceptance:**
- [ ] profile render tests: bio body, urls union, counts frontmatter
- [ ] import emits no blocks/mutes; follows body empty
- [ ] re-import over hydrated entries: all skipped, nothing reset

## Phase 5: Seed corpus (ops)

Backfill in slices; verify convergence (remaining unhydrated → 0), gone
count sane, url-scraper picks up new urls.

**Acceptance:**
- [ ] full backfill converged; spot-check entries
- [ ] second backfill run is a free no-op

---

## Phase log

|  |  |
|--|--|
|  |  |
