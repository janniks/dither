import { homedir } from "node:os";
import { join } from "node:path";

/**
 * macOS Transparency, Consent, and Control (TCC). Several `~/Library/...`
 * subtrees are guarded so that even reading them with the user's own UID
 * returns `EPERM` until the calling binary has been granted Full Disk
 * Access in System Settings → Privacy & Security.
 *
 * We can't request FDA programmatically; the best we can do is detect when
 * an error landed inside a protected prefix and surface a clean hint
 * pointing the user at the right setting.
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

/** Deep link to the FDA settings pane. Most modern terminals render it as clickable. */
export const FDA_SETTINGS_URI =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/** Error code stamped on errors that need the FDA-grant render path. */
export const FDA_REQUIRED = "FDA_REQUIRED";

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

/** Return the matching TCC prefix (relative to $HOME) if `path` is inside a protected location. */
export function tccPrefixFor(path: string, home = homedir()): string | null {
  if (!isMacOS()) return null;
  for (const rel of TCC_PREFIXES) {
    const abs = join(home, rel);
    if (path === abs || path.startsWith(`${abs}/`)) return rel;
  }
  return null;
}

/**
 * Pull the first protected path out of an error / stderr blob, if any.
 * Used at runtime to detect that a non-zero exit was an FDA failure.
 */
export function findProtectedPathInError(blob: string): string | null {
  const matches = blob.match(/\/[^\s"']*Library[^\s"']*/g);
  if (!matches) return null;
  for (const candidate of matches) {
    if (tccPrefixFor(candidate)) return candidate;
  }
  return null;
}

/**
 * The user-facing FDA error block. Facts only — no prescriptions about
 * where to grant FDA beyond the calling binary, and no terminal-app
 * recommendations (granting a terminal FDA is too broad).
 */
export function formatFdaError(failingPath: string, callerBinary = process.execPath): string {
  return [
    `error [FDA_REQUIRED]: EPERM opening ${failingPath}`,
    "",
    "This path is protected by macOS Full Disk Access (TCC). The calling",
    "binary needs Full Disk Access before the plugin can read it. Plugins",
    "inherit this grant from whichever binary launched the dither CLI;",
    "today that is:",
    "",
    `  ${callerBinary}`,
    "",
    "To grant it, open the Settings pane and add the binary above:",
    "",
    `  ${FDA_SETTINGS_URI}`,
    `  open -R ${callerBinary}`,
    "",
    "Heads-up: granting FDA to a Node binary is broader than ideal —",
    "every Node tool you run inherits the grant, and `nvm install …`",
    "will silently revoke it. A standalone signed dither binary is on",
    "the roadmap (see notes/fda-and-the-daemon.md); until then this is",
    "the available path.",
  ].join("\n");
}

/** Proactive install-time warning when a granted file path is TCC-protected. */
export function maybeWarnInstall(files: Record<string, string>): boolean {
  if (!isMacOS()) return false;
  const matched = Object.values(files).find((p) => tccPrefixFor(p) !== null);
  if (!matched) return false;
  console.error(
    [
      "",
      `note: '${matched}' is a macOS-protected location.`,
      `      The plugin will only be able to read it if Full Disk Access`,
      `      has been granted to:`,
      `        ${process.execPath}`,
      `      Open Settings: ${FDA_SETTINGS_URI}`,
      "",
    ].join("\n"),
  );
  return true;
}
