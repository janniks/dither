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
