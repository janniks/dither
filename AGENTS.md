# AGENTS.md

> **Simple made easy.** Rich Hickey / Steve Jobs style. Every change should make the system simpler, not just add to it.

- Functional, idiomatic, well-abstracted
- Simplify the plan first, then make notes on how to edit
- No premature abstractions/DRY (it's overrated)
- Prefer deleting code over adding code
- No over-engineering, no speculative features
- If it's not clearly needed right now, don't build it

## Generic agent management

### Format

- All work in md files, in-repo. No GitHub issues unless explicitly asked.
- Short bullets, few full sentences. Readable at 1/4 desktop width or on mobile.
- Commit after each meaningful change.

### Dirs

- `specs/` — feature intent (problem, stories, decisions). 1:1 by name with `plans/`. In-progress drafts suffixed `-DRAFT.md`.
- `plans/` — phased implementation. Active plan suffixed `-RUNNING.md` (contains an inline phase-log table).
- `notes/` — flat, unstructured scratchpad. One thought per file. Revisit only on request.
- `docs/` — stable reference (style guide, architecture).

### Flow

- `/grill-me` → `/create-spec` → `/create-plan` → implement phase-by-phase → commit per phase.
- In-progress artifacts are suffixed: `specs/<feature>-DRAFT.md` while interviewing, `plans/<feature>-RUNNING.md` while implementing. Rename back (drop the suffix) on finalize / completion.
- Tick acceptance criteria and append a phase-log row inside the `-RUNNING.md` plan after each commit.
- Deferred items: front-matter `status: deferred` on whatever file fits. No dedicated dir.

### Git

- **Never rewrite git history.** No `rebase -i`, no `--amend` of an existing commit, no `filter-branch`, no `rebase --exec` that amends, no `reset --hard` over commits, no force-push. Rewriting risks silently dropping work — including in-progress `specs/`, `plans/`, and `notes/` md files that aren't tracked anywhere else. Fix mistakes with a new follow-up commit (or `git revert`). If a commit must be reworked, ask first.
- Toolchain is npm with workspaces. Only `package-lock.json` at the repo root is committed; no per-package lockfiles, no `pnpm-lock.yaml` or `yarn.lock`.
- `~/.npmrc` enforces `min-release-age=7` (no deps published in the last 7 days) and `ignore-scripts=true` for security. Native modules (e.g. `better-sqlite3`) need their install scripts run manually — invoke `npm run install` inside the package dir when a binding is missing.

## Style Guide

### General principles (TypeScript)

- Keep things in one function unless composable or reusable
- Avoid try/catch where possible
- Avoid using the `any` type
- Prefer single-word variable names where possible
- Rely on type inference; avoid explicit type annotations unless necessary for exports or clarity
- Prefer functional array methods (`flatMap`, `filter`, `map`) over for loops
- Prefer `const` over `let`. Use ternaries or early returns instead of reassignment
- Avoid `else` statements. Prefer early returns
- Avoid unnecessary destructuring. Use dot notation to preserve context
- Reduce variable count by inlining when a value is only used once

```ts
// Good
const data = await fs.readFile(path.join(dir, "journal.json"), "utf-8");

// Bad
const journalPath = path.join(dir, "journal.json");
const data = await fs.readFile(journalPath, "utf-8");
```

### Naming

Prefer single-word names for variables and functions. Multi-word names only when a single word would be ambiguous.

- Good: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`
- Avoid unless required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`

### Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests

## CLI / TUI

All interactive output goes through `packages/cli/src/prompt.ts`. Don't pull in
new prompt or spinner deps — extend that module instead. Existing deps:
`consola` (prompts), `picocolors` (color), `node:readline` (cursor moves).

**Prompts (`promptText`).** One line. Bake any hint into the message in
parens — e.g. `Where should your library live? (ENTER for ~/.dither/library)`.
Don't stack a second hint line below; it clutters the rewrite zone.

**Confirmation (`confirm(label, value)`).** Call immediately after the prompt
resolves. It rewrites consola's echoed prompt line to `✓ Label: value`, so the
answer reads as "locked in" and the question disappears from scrollback.

**Progress (`stepStart` / `stepDone` / `stepFail`).** Bracket every step that
can take more than a beat — index walks, network fetches, model downloads.
Pattern:

```ts
stepStart("downloading model weights (first run, may take a minute)...");
const result = await prefetchWeights();
if (result.ok) stepDone("downloaded model weights");
else stepFail(`weight prefetch failed: ${result.reason}`);
```

The user must never wonder whether the CLI is hung. Both `→` and `✓` lines
stay in scrollback — they're the post-hoc log of what the command did, so
there's no separate end-of-run summary block. End with one blank line and a
single `next: <command>` nudge if there's an obvious follow-up.

Tests capturing output: spy both `console.log` and `process.stdout.write`
(see `init.test.ts` → `captureLogs`). The prompt helpers write directly to
stdout to keep cursor control intact.
