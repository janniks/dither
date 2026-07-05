import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import pc from "picocolors";
import { resolveHome } from "../home";
import { formatRelTime } from "../relative-time";
import {
  installPlugin,
  MissingInputsError,
  type InstallOptions,
  type InstalledPlugin,
} from "../plugin-install";
import {
  formatDryRun,
  InstallCancelledError,
  mergeInputs,
  planInstall,
  promptInteractive,
  readExistingGrants,
  readPackage,
} from "../plugin-install-interactive";
import { parseSchedule } from "../schedule-parser";
import { reloadDaemon, readDaemonPid, startDaemon } from "../daemon-control";
import { installAutostart } from "../persistence";

/**
 * Shared scaffolding for the plugin subcommands — grant-flag plumbing,
 * the install-or-exit helper used by both `install` and `run <path>`, and
 * the post-install hint + daemon-ensure helpers. Lives outside the
 * dispatcher so each subcommand can pull what it needs without a cycle.
 */

export const grantArgs = {
  env: {
    type: "string" as const,
    description: "Comma-separated NAME=VALUE pairs for declared env (literals).",
  },
  "allow-env": {
    type: "string" as const,
    description: "Comma-separated env names this plugin may read from `dither env`.",
  },
  file: {
    type: "string" as const,
    description: "Comma-separated ID=PATH pairs for declared files.",
  },
  "allow-net": {
    type: "string" as const,
    description: "Comma-separated hosts this plugin may reach. Subset of manifest `net`.",
  },
  create: {
    type: "string" as const,
    description:
      "Comma-separated collection globs this plugin may create entries in. Subset of manifest `create` (or a manual widen).",
  },
  edit: {
    type: "string" as const,
    description:
      "Comma-separated collection globs where this plugin may overwrite entries other plugins created. Grants beyond the manifest are flags-only — the interactive flow never offers them.",
  },
};

export interface GrantArgs {
  env?: string;
  "allow-env"?: string;
  file?: string;
  "allow-net"?: string;
  create?: string;
  edit?: string;
}

function parsePairs(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function readGrantArgs(args: GrantArgs) {
  return {
    env: parsePairs(args.env),
    envRefs: parseList(args["allow-env"]),
    files: parsePairs(args.file),
    net: parseList(args["allow-net"]),
    create: parseList(args.create),
    edit: parseList(args.edit),
  };
}

// consola's cancel-on-reject path throws a plain `Error("[consola] Prompt
// cancelled.")`. Match the message rather than relying on a stable type.
function isCancel(err: unknown): boolean {
  return err instanceof Error && /cancel/i.test(err.message);
}

/**
 * Install a plugin. On a TTY, drop into the interactive flow when the
 * manifest declares required env/files the caller didn't satisfy. On a
 * pipe / CI, surface MissingInputsError as a single enumerated stderr
 * line + exit 1, instead of citty's stack trace.
 */
export async function installPluginOrExit(opts: InstallOptions): Promise<InstalledPlugin> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  let merged = opts;
  if (interactive) {
    try {
      const parsed = await readPackage(opts.source);
      const existing = await readExistingGrants(parsed.name);
      const base = existing ? mergeInputs(existing, opts) : opts;
      const extra = await promptInteractive(parsed, opts, existing);
      merged = { ...opts, ...mergeInputs(base, extra) };
    } catch (err) {
      if (err instanceof InstallCancelledError || isCancel(err)) {
        process.stderr.write("\ninstall cancelled.\n");
        process.exit(130);
      }
      throw err;
    }
  }
  try {
    return await installPlugin(merged);
  } catch (err) {
    if (err instanceof MissingInputsError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * `install --dry-run`: preview the field/grant surface without installing
 * or prompting. Reads the same inputs as the interactive path (flags
 * layered over any prior grants) and runs the existing planner.
 */
export async function dryRunInstall(opts: InstallOptions): Promise<void> {
  const parsed = await readPackage(opts.source);
  const existing = await readExistingGrants(parsed.name);
  const plan = await planInstall(parsed, existing ? mergeInputs(existing, opts) : opts);
  process.stdout.write(formatDryRun(parsed, plan));
}

interface ConsentedGrants {
  schedule?: string | null;
  watch?: { collections?: string[]; dirs?: string[] } | null;
}

/** Every watched root: manifest collections plus user-added absolute dirs. */
function watchRoots(watch: NonNullable<ConsentedGrants["watch"]>): string[] {
  return [...(watch.collections ?? []), ...(watch.dirs ?? [])];
}

function readConsentedGrants(name: string): ConsentedGrants | null {
  const grantsPath = join(resolveHome(), "grants", `${name}.json`);
  try {
    return JSON.parse(readFileSync(grantsPath, "utf-8")) as ConsentedGrants;
  } catch {
    return null;
  }
}

/**
 * End-of-install hint. Pulls the just-written grants file to decide what
 * to nudge the user toward. `fromRunPath=true` is used when `plugin run
 * <path>` triggered the install — the run is already happening, so the
 * focus shifts to future runs.
 */
export function printInstallHint(name: string, fromRunPath: boolean): void {
  const grants = readConsentedGrants(name);
  if (!grants) return;
  if (fromRunPath) {
    process.stdout.write(`\nnote: grants persisted. future runs: 'dither plugin run ${name}'.\n`);
    return;
  }
  if (grants.schedule) {
    try {
      const next = new Cron(parseSchedule(grants.schedule)).nextRun();
      if (next) {
        process.stdout.write(pc.dim(`\nnext run: ${formatRelTime(next.getTime())} (${next.toISOString()})\n`));
      }
    } catch {
      // Invalid schedule — daemon will surface the real error at fire time.
    }
    process.stdout.write(pc.dim(`next: dither plugin run ${name} (manual one-shot fire)\n`));
    return;
  }
  const watch = grants.watch ? watchRoots(grants.watch) : [];
  if (watch.length > 0) {
    process.stdout.write(
      pc.dim(`\nnote: runs automatically when files change in: ${watch.join(", ")}\n` +
        `      'dither plugin run ${name}' fires it once.\n`),
    );
    return;
  }
  process.stdout.write(pc.dim(`\nnext: dither plugin run ${name}\n`));
}

/**
 * Make sure the daemon is up if (and only if) this plugin's grants declare
 * scheduled or watch work. Manual-only plugins don't need the daemon
 * resident. Best-effort: failures print a note and return.
 */
export async function ensureDaemonForPlugin(name: string): Promise<void> {
  const grants = readConsentedGrants(name);
  if (!grants) return;
  const needsDaemon =
    Boolean(grants.schedule) ||
    Boolean(grants.watch && watchRoots(grants.watch).length > 0);
  if (!needsDaemon) return;

  const alive = await readDaemonPid();
  if (!alive) {
    try {
      await startDaemon();
    } catch (err) {
      console.error(
        `note: could not start daemon automatically (${err instanceof Error ? err.message : String(err)}). ` +
          `run 'dither daemon start' to bring it up.`,
      );
      return;
    }
  } else {
    await reloadDaemon().catch(() => {});
  }

  if (process.env.DITHER_INSTALL_AUTOSTART === "1") {
    try {
      await installAutostart();
    } catch (err) {
      console.error(
        `note: autostart unit not installed (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }
}
