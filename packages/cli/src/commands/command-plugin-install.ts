import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { assertInitialized } from "../config";
import { openBrowser } from "../open-browser";
import { ditherText, promptConfirm } from "../prompt";
import { FDA_SETTINGS_URI, type ProtectedInstall } from "../tcc-hint";
import {
  grantArgs,
  readGrantArgs,
  installPluginOrExit,
  printInstallHint,
  ensureDaemonForPlugin,
} from "./command-plugin-shared";

/**
 * Smoke-test whether the *managed deno binary* can read a TCC-protected
 * path. Node's own FDA grant doesn't transfer — plugins run under the
 * managed deno, which has its own per-binary entry in System Settings.
 * Exit 0 → access works (silent advisory); anything else → surface it.
 *
 * Times out at 3s as a safety net (deno cold start is usually <500ms,
 * but FDA prompts on first hit can hang briefly).
 */
async function denoCanRead(denoPath: string, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const code = `Deno.statSync(${JSON.stringify(path)});`;
    const child = spawn(denoPath, ["eval", `--allow-read=${path}`, code], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 3_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Render the macOS Full Disk Access advisory in Dither's voice and, on a
 * TTY, offer to open System Settings now. On Yes spawn the deep link via
 * `openBrowser`; on No leave the URL in the note for later. Non-TTY just
 * prints the note (no prompt).
 *
 * `open` is injectable so tests don't actually spawn a Settings window.
 */
export async function handleProtectedInstall(
  info: ProtectedInstall,
  open: (url: string) => void = openBrowser,
): Promise<void> {
  // Skip the advisory when the managed deno already has FDA for this
  // path — the user already granted it. Only surface when actually blocked.
  if (await denoCanRead(info.callerBinary, info.path)) return;
  ditherText(
    [
      `'${info.path}' is a macOS-protected location.`,
      "",
      "The plugin will only read it after Full Disk Access has been",
      "granted to the dither-managed Deno:",
      `  ${info.callerBinary}`,
      "",
      "Drag the highlighted binary from Finder into the Full Disk",
      "Access list, or click '+' and pick it.",
      "",
      `Open Settings: ${info.settingsUri}`,
    ].join("\n"),
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  let yes: boolean;
  try {
    yes = await promptConfirm("Open System Settings now to grant Full Disk Access?", true);
  } catch {
    return;
  }
  if (!yes) return;
  open(info.settingsUri);
  if (process.platform === "darwin") {
    spawn("open", ["-R", info.callerBinary], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  }
}

export const installSubcommand = defineCommand({
  meta: {
    name: "install",
    description:
      "Install a plugin from a local path. Persists grants but doesn't run the plugin — use 'dither plugin run' for that.",
  },
  args: {
    source: {
      type: "positional",
      required: true,
      description: "Path to the plugin directory",
    },
    symlink: {
      type: "boolean",
      description:
        "Dev mode: symlink the install destination to the source path instead of copying. Author edits take effect without reinstall; node_modules + deno.json from the source are used as-is.",
      default: false,
    },
    ...grantArgs,
  },
  async run({ args }) {
    await assertInitialized();
    const grants = readGrantArgs(args);
    const result = await installPluginOrExit({
      source: args.source,
      ...grants,
      ...(args.symlink ? { symlink: true } : {}),
    });
    console.log(`\ninstalled ${result.name}@${result.version}${args.symlink ? " (symlinked)" : ""}`);
    console.log(`  → ${result.dest}`);
    if (result.protectedInstall) await handleProtectedInstall(result.protectedInstall);
    await ensureDaemonForPlugin(result.name).catch(() => {});
    printInstallHint(result.name, false);
    return result;
  },
});

// Re-export for callers that previously imported from commands/plugin.ts
export { FDA_SETTINGS_URI };
