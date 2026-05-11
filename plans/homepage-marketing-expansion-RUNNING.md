# Plan: Homepage Marketing Expansion

> Source spec: provided inline (no `specs/homepage-marketing-expansion.md` written; concept finalized in chat).

Expand the docs homepage (`app/(home)/page.tsx`) with 13 marketing inserts that frame **dither = a CLI wrapper around qmd + a Deno-sandboxed plugin runtime + scheduler/watcher + MCP server**, aimed at HN devs and skeptics. New sections live between the existing 3 link cards and the existing v0 status card; the rotating headline hero, link cards, status card, and footer are not modified.

## Architectural decisions

- **Route**: existing `/` only. No new routes.
- **Layout shell**: existing `app/(home)/page.tsx` stays the entry; new sections are sibling components imported into the same `max-w-[1080px]` content column. Full-bleed (escape the column) is reserved for shader rows where it improves the rhythm — sphere/wave rows may stretch to viewport width.
- **Shared primitives**:
  - `Dithering` from `@paper-design/shaders-react` (already installed) — only `shape: "wave"` and `shape: "sphere"` allowed.
  - `Terminal`, `TypingAnimation`, `AnimatedSpan` from `lib/terminal.tsx` (already in repo).
  - Tailwind v4 utility classes; theme tokens via `bg-fd-*`, `text-fd-*`, etc.; `next-themes` already wired.
- **Content provenance**: Manifesto copied verbatim from `../mmry-homepage-new/app/page.tsx:600–675`. User will edit after paste.
- **Section ordering** between existing `link cards` and `v0 status card`:
  1. Feature grid (4 cards: qmd-powered · Deno-sandboxed plugins · Scheduled & watched · MCP-ready)
  2. No-BS callout strip
  3. Plugin USP — code + grants manifest
  4. Wave shader row + 3 plugin chips
  5. Schedule & watch terminal demo
  6. Plugin marketplace grid (9 cards, shipped/wip/planned labels)
  7. Terminal demo #1 (init → add → search)
  8. Architecture SVG diagram
  9. MCP terminal demo
  10. Sphere shader row
  11. Manifesto
  12. FAQ (5 questions)
  13. OSS / hackability card
- **External links** (durable):
  - qmd repo / docs link — referenced from feature grid card 1 and FAQ #1. URL TBD, single source via a constant.
  - dither GitHub repo — referenced from OSS card and elsewhere.
- **Component layout policy**: each insert lives in its own component file under `app/(home)/` (or a subfolder) so `page.tsx` stays scannable. Client/server boundary: components that animate (terminals, shaders, motion) are `"use client"`; static markup stays server-rendered.
- **Animation budget**: shader rows animate themselves (paper-design); terminals run typed sequences on viewport entry; everything else is static. No motion-on-scroll fluff.
- **Responsive policy**: feature grid 4-across on `md+`, 2×2 below; two-column USP / schedule / shader rows stack on `< md`; terminal max-width capped so it never dominates the viewport on mobile.

---

## Phase 1: Tracer bullet — full-page scaffold

End-to-end behavior: every section exists as a stub component, wired into the homepage in the agreed order. The page reads top-to-bottom with all 13 inserts visible. Layout, scroll, and responsiveness are settled before any content polish. Each stub renders a section heading, a one-line description, and a placeholder visual (basic shader, single-line terminal, ASCII box, etc.) so the rhythm is real.

**Acceptance:**
- [x] All 13 new sections render between the existing link cards and the v0 status card.
- [x] No existing section is modified (rotating headline, link cards, v0 status, footer).
- [x] Each section is its own component file imported into `page.tsx`.
- [x] Page is responsive: usable on 390px, 768px, 1280px, 1920px viewports.
- [x] No console errors; no layout overflow on any of the above widths.
- [x] `qmd` is mentioned at least once in section 1 and at least once in section 12.
- [x] `Deno` is mentioned at least once in section 1 and section 3.
- [x] Sphere row (section 10) appears *after* wave row (section 4).

---

## Phase 2: Foundations and skim-readers

Polish the sections a hurried reader will actually see: feature grid, no-BS strip, OSS hackability card. These three frame everything: the grid sets the technical stake (qmd, Deno, scheduling, MCP), the strip handles the "is this another SaaS?" reflex, the OSS card closes the loop with "read the source."

**Acceptance:**
- [x] Feature grid (section 1) has 4 cards with real icons, real titles, and real one-line bodies; qmd link present and clickable; Deno mentioned in card 2.
- [x] Grid is 4-across on `md+`, 2×2 on `< md`.
- [x] No-BS strip (section 2) is a single-line emphatic block; types correctly on dark and light themes; respects 760px content max width.
- [x] OSS card (section 13) has a repo URL link and a one-liner; visually consistent with existing v0 status card.

---

## Phase 3: Plugin USP narrative

The plugin story is the real USP — sections 3, 4, 6 work together. Section 3 *shows the API surface* (code + grants), section 4 *frames it lyrically* (wave shader + chips), section 6 *proves there's a marketplace* (9 cards with honest shipping labels). Together they should leave a reader thinking "ok, the plugin model is the differentiator."

**Acceptance:**
- [ ] Plugin USP (section 3) is a 2-column block: left = a 30–50 line representative TypeScript Deno plugin, right = the grants manifest declaring `net` / `env` / `fs`. Code is syntax-highlighted; manifest is in a styled box.
- [ ] Wave shader row (section 4) renders a `Dithering shape="wave"` shader, has 3 inline plugin chips (Twitter / Pocket / Raindrop) under a one-paragraph pitch.
- [ ] Plugin marketplace grid (section 6) shows 9 plugin cards with icon + name + 1-line + status label (`shipped` / `wip` / `planned`); cards in `wip` and `planned` are visually de-emphasized.
- [ ] Cards link out to per-plugin docs OR are clearly non-clickable (consistent within the grid).
- [ ] Wave row stacks correctly on `< md` (shader on top, copy below).

---

## Phase 4: Schedule/watch + terminals

Hands-off ingest is the second-strongest USP after the sandbox. Sections 5, 7, 9 use `Terminal` + `TypingAnimation` to animate concrete CLI sequences. Each terminal sequence must read like real output a real user would see, not invented marketing prose.

**Acceptance:**
- [ ] Schedule & watch demo (section 5) shows two commands (`dither schedule add …` and `dither watch …`) with realistic stdout: schedule confirmation + watcher tick lines. Caption next to it explains cron / fs-watch / one-shot.
- [ ] Terminal demo #1 (section 7) runs `dither init` → `dither add` → `dither search` with one or two result lines. A short caption beside the terminal explains the mental model in 2 sentences.
- [ ] MCP terminal demo (section 9) shows `dither mcp serve` + tools list + the `claude mcp add` install line.
- [ ] All three terminals start typing only when the section enters the viewport (existing `Terminal` behavior).
- [ ] Terminals stay readable on `< md` (no horizontal scroll, font scales appropriately).

---

## Phase 5: Architecture + lyrical close

The architecture diagram (section 8) earns the "wrapper around qmd" claim with a single picture. The sphere shader row (section 10) is the lyrical payoff that lands *after* a reader has been convinced by the technical sections — never first.

**Acceptance:**
- [ ] Architecture diagram (section 8) renders as inline SVG showing: `markdown on disk` ⇄ `qmd index` ⇄ `dither core` → `{ CLI · MCP server · scheduler · watcher · Deno plugin runtime }`.
- [ ] Diagram colors / borders use theme tokens; readable on light and dark.
- [ ] Diagram is replaced by a textual fallback below `< md` if the SVG would be cramped, OR scales gracefully — pick one explicitly.
- [ ] Sphere shader row (section 10) renders `Dithering shape="sphere"` and a one-paragraph lyrical pitch ("Your data has a center now."). Sphere is positioned to feel like a payoff, not a stunt.

---

## Phase 6: Manifesto + FAQ + final polish

Manifesto (verbatim, will be edited later by the user) gives the emotional close; FAQ deflects the predictable HN comments before they're typed. qmd link reinforced in FAQ #1.

**Acceptance:**
- [ ] Manifesto (section 11) renders the full text from `mmry-homepage-new/app/page.tsx:600–675` verbatim, in a bordered card with serif body. Highlight-style inline marks (the yellow underlines in the source) preserved as `<mark>`-style spans or equivalent.
- [ ] FAQ (section 12) shows 5 questions with answers:
  1. *What's qmd?* → 2-line answer with a link to qmd.
  2. *Does it phone home?* → No.
  3. *Can plugins exfiltrate data?* → grants story.
  4. *Headless schedule?* → daemon answer.
  5. *Encryption at rest?* → use FileVault/LUKS.
- [ ] FAQ items are either always-open or use a native `<details>` so they collapse cleanly. No external accordion library.
- [ ] Final pass on the whole homepage: vertical rhythm consistent (gap-14 column, full-bleed shader rows where chosen); typography tightened; the page reads top-to-bottom without any "why is this here?" section.

---

## Phase log

When starting implementation, rename this file to `./plans/homepage-marketing-expansion-RUNNING.md`. Work one phase at a time, ticking each phase's acceptance criteria as you satisfy them. After finishing a phase, stage and commit only that phase's changes, then continue to the next phase autonomously. Append a row to the log below after every phase. When all phases complete, rename back to `./plans/homepage-marketing-expansion.md`.

| Commit | Summary |
|--------|---------|
| `94ae1c9` | Phase 1 — tracer bullet: 13 stub components scaffolded under `app/(home)/marketing/`, wired into `page.tsx` in agreed order. All acceptance criteria met. |
