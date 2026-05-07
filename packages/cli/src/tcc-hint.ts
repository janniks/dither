import { homedir } from "node:os";
import { join } from "node:path";

/**
 * macOS Transparency, Consent, and Control (TCC) hint surface. Several
 * `~/Library/...` subtrees are guarded by macOS so that even reading them
 * with the user's own UID returns `EPERM` until the *parent process* has
 * been granted Full Disk Access (or the specific TCC-class entitlement) in
 * System Settings → Privacy & Security.
 *
 * Plugins run as Deno children of the dither binary and inherit the parent's
 * TCC grants — the user has to add `node` (or whatever execPath this build
 * runs under) to FDA, not the plugin script. We can't request FDA
 * programmatically; the best we can do is detect when a grant or a runtime
 * error lands inside a protected prefix and tell the user where to look.
 */

const TCC_PREFIXES = [
  "Library/Messages",
  "Library/Mail",
  "Library/Calendars",
  "Library/Reminders",
  "Library/Photos",
  "Library/Application Support/AddressBook",
  "Library/Application Support/CallHistoryDB",
  "Library/Application Support/com.apple.TCC",
  "Library/HomeKit",
  "Library/Safari",
];

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

/**
 * Return the matching TCC prefix (relative to $HOME) if `path` is inside a
 * protected location, else null.
 */
export function tccPrefixFor(path: string, home = homedir()): string | null {
  if (!isMacOS()) return null;
  for (const rel of TCC_PREFIXES) {
    const abs = join(home, rel);
    if (path === abs || path.startsWith(`${abs}/`)) return rel;
  }
  return null;
}

/**
 * Build the user-facing hint string used both at install time (proactive)
 * and at runtime (reactive when EPERM lands).
 */
export function fdaHint(execPath = process.execPath): string {
  return [
    "macOS Full Disk Access required.",
    "  Open System Settings → Privacy & Security → Full Disk Access,",
    "  click +, and add this binary:",
    `    ${execPath}`,
    "  Then re-run dither. Plugins inherit FDA from the dither binary.",
  ].join("\n");
}

/**
 * Scan `files` grants for TCC-protected paths and emit the hint once if any
 * matched. Returns true if a hint was printed.
 */
export function maybeWarnInstall(files: Record<string, string>): boolean {
  if (!isMacOS()) return false;
  const matched = Object.values(files).find((p) => tccPrefixFor(p) !== null);
  if (!matched) return false;
  console.error(`\n${fdaHint()}\n  (triggered by grant on ${matched})\n`);
  return true;
}

/**
 * Wrap an error message at runtime: if the underlying error is EPERM-ish and
 * its path lives under a TCC-protected prefix, prepend the hint.
 */
export function wrapRuntimeError(err: Error & { path?: string; code?: string }): Error {
  if (!isMacOS()) return err;
  if (err.code !== "EPERM" && err.code !== "EACCES" && !/EPERM|EACCES/.test(err.message)) {
    return err;
  }
  const path = err.path;
  if (!path || tccPrefixFor(path) === null) return err;
  const wrapped = new Error(`${err.message}\n\n${fdaHint()}`);
  (wrapped as Error & { code?: string; path?: string }).code = err.code;
  (wrapped as Error & { code?: string; path?: string }).path = path;
  return wrapped;
}
