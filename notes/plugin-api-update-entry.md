---
status: feature wish
priority: P2
---

# Plugin API: update existing entry's frontmatter

## What's missing

The plugin SDK can `writeEntry()` (create or overwrite a whole entry) and
`readState()`/`writeState()` (private per-plugin state). It has **no API for
modifying an existing entry's frontmatter without rewriting the body**.

The host *does* permit overwrites when the existing entry's `source` matches
the calling plugin (`plugin-run.ts:130-140`), so a plugin can update its own
entries today — but only by re-emitting the full body, which it usually doesn't
have in memory and can't read back from the library (no allow-read on
`library/`).

## Concrete need (url-scraper)

URL-scraper dedupes by URL → one scraped entry per unique URL. When a *new*
parent (a twitter like, an iMessage row, …) references a URL we already
scraped:
- We don't want to re-fetch (waste; rate-limit; cache-busting).
- We *do* want to append the new parent to the entry's `dither_parent_id`
  (and `dither_parent_path`) lists.
- We don't have the body text in memory — we'd need to re-extract via
  Readability, defeating the dedupe.

Without the API, the test.local plugin will leave some new parents
unlinked. Documented as a known limitation.

## Sketch of the API

```ts
import { patchEntry } from "@dither/plugin";

await patchEntry({
  collection: "urls/github.com",
  filename: "9f3c6b1a2c4e.md",
  // Merge semantics: scalar overwrite, array append-unique, object deep-merge.
  // Anything not mentioned is left alone. Body is untouched.
  frontmatterMerge: {
    dither_parent_id: { append: ["new-parent-id"] },
    dither_parent_path: { append: ["twitter/likes/2026/123.md"] },
  },
});
```

Or a simpler shape that mirrors `writeEntry`:

```ts
await patchEntry({
  collection: "urls/github.com",
  id: "9f3c6b1a2c4e",
  appendToList: { dither_parent_id: ["new-parent-id"] },
  set: { last_seen_parent_at: "2026-05-08T..." },
});
```

## Where this lives in the host

- New SDK function `patchEntry()` writes a small NDJSON control message (like
  `progress()`) instructing the host to mutate the on-disk entry post-run.
- Or: a new staging convention — plugin writes `<runDir>/_patches.ndjson`
  with one patch op per line; host applies them during the same promote pass.
- Source-ownership check still applies: a plugin can only patch entries whose
  `source` is itself.
- Validation: list operations must keep the field a list; scalar set on a
  list field errors out.
- Idempotence: append-unique by default — if the value is already present,
  it's a no-op.

## Alternative we should also consider

Move the parent linkback **out of the scraped entry**, into a separate
relationship store. Either:
- A side index file (`~/.dither/index/url-parents.json`) with `{ url: [parent_id, ...] }`.
- A new dither concept: relationships as their own kind of artifact.

Pros: no need for a frontmatter-mutation API; cleaner separation of "what
this URL is" (immutable scraped content) from "who linked here" (growing list).
Cons: introduces a second source of truth that search/get won't surface
naturally; needs UI/query support to be useful.

## Out of scope (this note)

- Whether dither should support arbitrary cross-entry relationships as a
  first-class concept (probably yes long-term; defer).
- How the daemon's loop detector interacts with patch-only updates (a
  patch is technically a write to a watched collection — should it
  trigger watchers or not?).

## Proposed next steps

1. Land url-scraper test.local plugin with a TODO marking the unlinked-parent
   case.
2. Spec out `patchEntry()` properly (own spec file, e.g. `specs/plugin-patch-entry.md`).
3. Decide between in-frontmatter parent lists vs a separate relationship store
   when the broader dither relationship model gets discussed.
