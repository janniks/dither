# UNSURE

> Agents: append decisions you were unsure about but had to make. When in doubt, log it — too many beats too few. Never edit or delete existing entries; humans write a `verdict:` and check the box.

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

## 2026-08-03 — homepage Agentation feedback (18 items)

- [ ] item 16 "this section after community plugins, switch" mapped to PluginUsp
  - choice: moved PluginUsp (sandboxed TS code sample) to after WaveRow (community plugins)
  - alternative: could have meant NoBsStrip or TerminalTabs — the location selector was ambiguous (`.flex > .flex > .flex`)
  - why: product-flow reading — show the plugin list first, then "plugins are simple TypeScript"
  - verdict:
- [ ] plugin-run homepage demo shows raw JSONL output
  - choice: transcript mirrors the real CLI (`{"type":"log",...}` lines) per "make sure all examples reflect latest CLI output exactly"
  - alternative: prettified fake output that reads nicer in marketing
  - why: exactness was explicitly requested; honest output fits the no-BS brand
  - verdict:
- [ ] h1 rewrite → "Archive all your ___ as markdown"
  - choice: minimal swap of "Access" → "Archive"; other candidates listed in session summary
  - alternative: bigger restructure e.g. "Your ___, archived as markdown" / "An archive of everything you ___"
  - why: keeps the rotating-chip layout logic intact; archive verb carries the product story
  - verdict:
- [ ] Raindrop icon is a lucide droplet, not the official mark
  - choice: simple-icons has no raindrop slug (trademark removals); used Droplet stand-in in tool-icons.tsx
  - alternative: user provides official SVG to drop into tool-icons.tsx
  - verdict:

## 2026-08-03 — homepage feedback round 3

- [ ] items 5/6 "border card / parent less max width" mapped to OssCard only
  - choice: constrained OssCard to max-w-[880px] mx-auto; did not narrow any parent container
  - alternative: could have meant the FAQ card + its section, or the whole 1080px page column
  - why: OssCard is the only bordered direct child of the column; parent selector was ambiguous
  - verdict:
