# AGENTS.md

## Development philosophy

> **Simple made easy.** Rich Hickey / Steve Jobs style. Every change should make the system simpler, not just add to it.

- Functional, idiomatic, well-abstracted
- Simplify the plan first, then make notes on how to edit
- No premature abstractions/DRY (it's overrated)
- Prefer deleting code over adding code
- No over-engineering, no speculative features
- If it's not clearly needed right now, don't build it

### Agent format

- All work in md files, in-repo. No GitHub issues unless explicitly asked.
- Short bullets, few full sentences. Readable at 1/4 desktop width or on mobile.
- Commit after each meaningful change.

### Directories

- `specs/` — feature intent (problem, stories, decisions). In-progress drafts suffixed `-DRAFT.md`. Complex features get a `## Refinement` section (interfaces, estimates, slices) instead of a separate plan.
- `notes/` — flat, unstructured scratchpad. One thought per file. Revisit only on request.
- `docs/` — stable reference (architecture).
- `plans/` — historical only (pre-2026-07 workflow used separate plan files). Don't add new ones.

### Conventions

- `CONVENTIONS.md` — the codebase's conventions and patterns (naming above all). Read it in full before implementing any feature.

### Papercuts & Unsure

- `PAPERCUTS.md` — read at session start; things that didn't go as planned, logged so the next session skips the detour.
  - Trigger: 2+ failed attempts before something worked, or a surprise. Test: would this have saved future-you a detour?
  - Append-only dated bullets, detail as indented sub-bullets. Add `- spec: <file>` only when the origin matters. Refactor/clean only with good reason.
- `UNSURE.md` — decisions made while unsure but had to pick one. Append liberally — too many beats too few. Never edit or delete existing entries; humans resolve them.
  - Group entries under `## <date> — <spec/note file>`. Each entry is a checkbox with choice, alternative, and why as sub-bullets.
  - Humans review: write a `verdict:` sub-bullet, check the box. Checked entries are swept on occasional cleanup passes.

### Workflow

- `/grill-me` → `/create-spec` → (complex features: `/refine-spec`) → implement slice-by-slice → commit per slice.
- Small features go straight from spec to implementation. Refine only when the feature is complex enough to earn it.
- While implementing, track progress in a transient root-level `WIP-<feature>.md` — current slice, small notes for crash recovery. Delete it on completion; the spec and commits are the record.
- Tick acceptance criteria in the spec after each commit.
- Deferred items: front-matter `status: deferred` on whatever file fits. No dedicated dir.

## Project Specific Notes

### Git

- **Never rewrite git history.** No `rebase -i`, no `--amend` of an existing commit, no `filter-branch`, no `rebase --exec` that amends, no `reset --hard` over commits, no force-push. Rewriting risks silently dropping work — including in-progress `specs/` and `notes/` md files that aren't tracked anywhere else. Fix mistakes with a new follow-up commit (or `git revert`). If a commit must be reworked, ask first.
- Toolchain is npm with workspaces. Only `package-lock.json` at the repo root is committed; no per-package lockfiles, no `pnpm-lock.yaml` or `yarn.lock`.
- `~/.npmrc` enforces `min-release-age=7` (no deps published in the last 7 days) and `ignore-scripts=true` for security. Native modules (e.g. `better-sqlite3`) need their install scripts run manually — invoke `npm run install` inside the package dir when a binding is missing.

### Data

- The dither library (`~/.config/dither` + the markdown library) is prod data. Read code first, use temp-dir tests, ask before any delete, cap smoke runs before corpus writes.
