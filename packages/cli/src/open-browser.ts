// Cross-platform "open this URL in the user's default browser". Best-effort:
// spawn errors are swallowed (the URL is always also printed elsewhere).

import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
    ? "start"
    : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore", shell: process.platform === "win32" })
    .on("error", () => {})
    .unref();
}
