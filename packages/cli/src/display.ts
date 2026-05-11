import { homedir } from "node:os";

/**
 * Display-only path helpers. Output-formatting concerns only — never
 * write the abbreviated form back into config or grants.
 */

const HOME = homedir();

/**
 * Substitute `~` for the current user's home in display output.
 *   /Users/jannik/.dither/foo → ~/.dither/foo
 *   /Users/jannik             → ~
 *   /Users/other/foo          → /Users/other/foo (unchanged)
 *
 * Strictly prefix-based; doesn't follow symlinks or normalise.
 */
export function tildePath(p: string): string {
  if (p === HOME) return "~";
  if (p.startsWith(`${HOME}/`)) return `~${p.slice(HOME.length)}`;
  return p;
}
