import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { configDir } from "./paths";

/**
 * OS-level persistence: write a launchd plist (macOS) or systemd user unit
 * (Linux) so the dither daemon comes back across reboots. We *only* write
 * the file — registering it (`launchctl load` / `systemctl --user enable`)
 * is left to the user opting in via $DITHER_INSTALL_AUTOSTART=1.
 *
 * Why split it: the file is harmless to generate, but `launchctl load` against
 * a real user's launchd has visible side effects we don't want triggered by
 * a test or a one-off install.
 */

export type Platform = "darwin" | "linux" | "other";

function detectPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return "other";
}

export interface AutostartPaths {
  platform: Platform;
  unitPath: string | null;
}

export function autostartPaths(home = homedir()): AutostartPaths {
  const platform = detectPlatform();
  if (platform === "darwin") {
    return { platform, unitPath: join(home, "Library", "LaunchAgents", "dev.dither.daemon.plist") };
  }
  if (platform === "linux") {
    return { platform, unitPath: join(home, ".config", "systemd", "user", "dither.service") };
  }
  return { platform, unitPath: null };
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/%/g, "%%")}"`;
}

export function macPlist(execPath: string, entry: string, ditherHome: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.dither.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlText(execPath)}</string>
    <string>${xmlText(entry)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DITHER_DIR</key><string>${xmlText(ditherHome)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xmlText(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlText(logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(execPath: string, entry: string, ditherHome: string): string {
  return `[Unit]
Description=Dither personal index daemon
After=default.target

[Service]
Type=simple
ExecStart=${[execPath, entry, "daemon", "run"].map(systemdQuote).join(" ")}
Environment=${systemdQuote(`DITHER_DIR=${ditherHome}`)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface AutostartResult {
  written: boolean;
  unchanged: boolean;
  unitPath: string | null;
  platform: Platform;
}

/**
 * Generate (or update) the launchd plist / systemd unit file. Idempotent —
 * if the file already exists with the same content, returns `unchanged: true`
 * without rewriting. Returns `{ written: false }` on unsupported platforms.
 */
export async function installAutostart(home = homedir()): Promise<AutostartResult> {
  const { platform, unitPath } = autostartPaths(home);
  if (!unitPath) return { written: false, unchanged: false, unitPath: null, platform };

  const execPath = process.execPath;
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine CLI entrypoint for autostart unit");

  const ditherHome = configDir();
  const logPath = join(ditherHome, "logs", "daemon.log");
  const content =
    platform === "darwin"
      ? macPlist(execPath, entry, ditherHome, logPath)
      : systemdUnit(execPath, entry, ditherHome);

  if (existsSync(unitPath)) {
    const existing = await readFile(unitPath, "utf-8");
    if (existing === content) {
      return { written: false, unchanged: true, unitPath, platform };
    }
  }

  await mkdir(dirname(unitPath), { recursive: true });
  await writeFile(unitPath, content);
  return { written: true, unchanged: false, unitPath, platform };
}
