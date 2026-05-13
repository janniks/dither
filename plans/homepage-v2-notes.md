# Homepage v2 — working notes

Ideation log from mentor-feedback pass. Not a spec yet — captures decisions made and parking lots so nothing gets lost between sessions.

## Decided (this pass)

- **Hero — keep rotating headline.** Do not collapse rotation to a fixed phrase.
- **Hero description** — prepend "Open Source" at the start. Whole line still up for rewording (see Parking Lot).
- **New section: "It's just markdown."** Anchor the markdown-on-disk story as a dedicated section, not just a tagline. (Open: where it sits — likely above FeatureGrid, after the new tabbed terminal block.)
- **New section before FeatureGrid: tabbed terminal demo.**
  - Three clickable tabs above the terminal (rendered as text with `→` between them, behaving as cycle controls).
  - Demo 1: `dither init` flow that ends with adding a file.
  - Demo 2: plugin run.
  - Demo 3: TBD — placeholder ideas: search across collections, watcher firing on a file change, MCP / agent angle.
- **Tagline / manifesto-adjacent line rewrite.** Don't like the current:
  > "A qmd wrapper with a sandboxed plugin runtime. No SaaS. No telemetry. Markdown on disk; the index is a single qmd file you can rm."
  Issues: the `rm` line and "index" framing feel forced/in-the-weeds, qmd already mentioned elsewhere. Lean harder on security + no-rugpull. Candidate angle: "your files stay markdown, nobody can rugpull your data."

## Parked for later

- **Direction C (split-card hero: filetree + open file).** Liked, but not now. Will mock when we re-open hero. Keep rotation, layer the split-card *under* the headline rather than beside it.
- **Hero CTA reshuffle** — possibly add "Browse plugins" or swap "CLI Reference" → "View on GitHub". Not this pass.
- **Trust strip** under CTAs ("MIT · Sandboxed · No backend"). Not this pass.

## Decisions from ideation round 2

- **Terminal is animated.** Type commands char-by-char (~22–28ms), dump output in bursts. Play once on mount via IntersectionObserver — no looping. Tab click = cancel current, restart new. Respect `prefers-reduced-motion` (jump to final frame). Check `terminal-init.tsx` / `terminal-mcp.tsx` for a reusable typewriter primitive before rolling new.
- **Demo 3 = `dither search`** against `openindex/test.local` — run the current plugin version on the real local corpus, not faked output. Reference `d status` snapshot from that working tree (5 collections, 131,582 entries, daemon not running) for the cold-state framing before the search. Closes the init → ingest → search loop and the output is *true*, which is the whole point.
- **"It's just markdown" = visual, side-by-side.** Left card: file path label + raw md source (monospace). Right card: same content rendered as styled markdown. Caption: "Same file. Your editor sees the left. Dither sees the right. There's no third version." → carries the anti-rugpull argument visually.
- **Tagline locked** (no-bs strip): "Open source. Sandboxed. Your files stay markdown. Nobody can rugpull your data." Four sentences, no emdash. "Open source." and "Sandboxed." rendered in muted weight; the two ownership-claims at full opacity.
- **Wave-row headline locked**: "Bring your data home." → "Secure the data that belongs to you."
- **Wave-row description rewritten** to lose the repeated sandbox/grant beats: "Plugins pull from feeds, folders, and APIs into your collections — each one a Deno script that runs only with the permissions you grant. Write your own in ~20 lines of TypeScript."

## Order of operations (current best guess)

1. ~~Hero description tweak (add "Open Source", land a tagline variant).~~ ✓ no-bs-strip + wave-row landed.
2. ~~Tabbed terminal section (new component, slotted above FeatureGrid).~~ ✓ `marketing/terminal-tabs.tsx`, three tabs: init / plugin run / search. Remounts on tab click to replay.
3. ~~"It's just markdown" section.~~ ✓ `marketing/just-markdown.tsx`, side-by-side raw md / rendered cards with macOS chrome.
4. ~~Marketplace → Plugins rename + per-plugin GitHub link.~~ ✓ wave-row: id `#marketplace` → `#plugins`, "Plugin Market" → "Plugins", every card is now an `<a>` linking to `github.com/dither-plugins/<name>` with the repo path printed in the footer. "planned" badge displays "Coming soon".
5. ~~Fix broken qmd link in docs.~~ ✓ `tobilu/qmd` (404) → `tobi/qmd` in `index.mdx` + `collections.mdx`.
6. ~~FAQ adds.~~ ✓ "Will I get rugpulled?" (monetization stance) + "Does it play nice with Obsidian?".
7. ~~Terminal layout-shift.~~ ✓ each Terminal in TerminalTabs gets `!max-h-none min-h-[440px]` so all three demos occupy the same vertical box; the page below FeatureGrid no longer hops on tab switch.
8. (Later) hero split-card, trust strip, CTA reshuffle.

## Implementation notes (so future-me doesn't relearn)

- Reused `Terminal` / `TypingAnimation` / `AnimatedSpan` from `docs/lib/terminal.tsx`. Sequence + `useInView` already wired; first viewing of a tab auto-plays. Remount via `key={active}` on the wrapper replays on tab switch.
- `TypingAnimation` requires a string child. Multi-segment colored output uses `AnimatedSpan` per line.
- Search demo numbers (5 collections / 131,582 entries) come from real `d status` on the test.local working tree. Update if the real numbers drift meaningfully.
