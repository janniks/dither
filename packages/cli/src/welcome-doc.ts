import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The library subdir that becomes the qmd collection holding the welcome
 * doc. Because library subdirs are collections per `store.ts:25-31`, the
 * doc is indexed and searchable as soon as the next `update()` runs.
 */
export const WELCOME_COLLECTION_DIR = "welcome";

/** Filename of the welcome doc inside `WELCOME_COLLECTION_DIR`. */
export const WELCOME_DOC_FILENAME = "welcome.md";

/**
 * Hardcoded markdown content. Short on purpose — the doc's job is to
 * demo `dither search` → `dither get`, not to be a manual. Keep it under
 * a screenful.
 */
const WELCOME_CONTENT = `# Welcome to dither

This is your first document. You found it by running:

    dither search 'welcome to dither'
    dither get <id from above>

That's the core pattern for retrieving anything in your library — search
by intent, then open the result by id.

## A few other commands

- \`dither status\` — what is dither currently doing?
- \`dither plugin install <path>\` — add a plugin that adds documents
  to your library (think feeds, scrapers, sync jobs).
- \`dither index update\` — rebuild the index after manual file changes.

## Removing this collection

This doc lives in a \`welcome/\` subdirectory of your library, which
automatically became a qmd collection. To remove it:

    rm -rf <library>/welcome
    dither index update

After that, this file will no longer appear in search results.
`;

/**
 * Path of the welcome doc relative to a given library root.
 */
export function welcomeDocPath(libraryPath: string): string {
  return join(libraryPath, WELCOME_COLLECTION_DIR, WELCOME_DOC_FILENAME);
}

/**
 * Whether the welcome doc currently exists in the given library. Drives
 * the init epilogue's choice of next-action lines.
 */
export function welcomeDocExists(libraryPath: string): boolean {
  return existsSync(welcomeDocPath(libraryPath));
}

/**
 * Idempotent write: creates `<library>/welcome/welcome.md` only if the
 * file doesn't already exist. Returns whether we actually wrote and the
 * resolved path either way. Re-running `dither init` after the user
 * edited their welcome doc must never clobber their edits.
 */
export async function writeWelcomeIfMissing(
  libraryPath: string,
): Promise<{ path: string; written: boolean }> {
  const path = welcomeDocPath(libraryPath);
  if (existsSync(path)) return { path, written: false };
  await mkdir(join(libraryPath, WELCOME_COLLECTION_DIR), { recursive: true });
  await writeFile(path, WELCOME_CONTENT, "utf-8");
  return { path, written: true };
}
