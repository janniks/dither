# UNSURE

> Agents: append decisions you were unsure about but had to make. When in doubt, log it — too many beats too few. Never edit or delete existing entries; humans write a `verdict:` and check the box.

## 2026-07-10 — specs/example.md

- [ ] example: chose Zod over valibot
  - both viable; picked ecosystem maturity
  - verdict:

## 2026-07-10 — specs/grants-module-DRAFT.md

- [ ] readGrants throws on corrupt JSON (returns null only for missing file)
  - alternative: null on corrupt too, like old readConsentedGrants
  - why: a run silently proceeding with empty permissions is worse than a loud crash; reinstall path keeps its own catch → treat-as-fresh
  - verdict:
- [ ] readGrants normalizes create/edit/net to [] — a legacy file gains those fields on the next read-modify-write
  - alternative: leave absent fields absent on disk
  - why: normalized shape lets every consumer drop its `?? []`; only write-back paths (configurePlugin) persist the change
  - verdict:
- [ ] configurePlugin on a missing grants file now errors cleanly instead of crashing with ENOENT
  - alternative: preserve the raw throw
  - why: clean message beats a stack trace; same terminal outcome
  - verdict:

## 2026-07-13 — CONVENTIONS.md (full scan)

- [ ] enshrined `Options` over `Opts` as the type-suffix rule
  - alternative: let both coexist (pkce.ts, oauth-listen.ts, table.ts use `Opts`/`ColOpt`)
  - why: `Options` dominates the export surface; one spelling is simpler; existing `Opts` types left as-is until touched
  - verdict:
- [ ] enshrined per-test-file `captureLogs` duplication as intentional (don't extract)
  - alternative: shared test util in test/helpers/
  - why: matches the repo's no-premature-DRY stance; each copy is ~10 lines
  - verdict:
- [ ] documented plugin family's file-per-subcommand vs inline subcommands elsewhere as size-driven, not conflicting
  - alternative: pick one style and migrate the other
  - why: splitting only pays past a size threshold; command-plugin.ts documents its own pattern
  - verdict:
