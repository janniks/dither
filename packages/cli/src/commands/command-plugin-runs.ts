import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../home";
import { findLastRunForPlugin, listRuns } from "../run-log";
import { formatRelPast } from "../relative-time";
import { printTable } from "../prompt";
import { tailRun } from "./command-plugin-run";

// `generateRunId` (run-log.ts) emits `YYYYMMDDTHHMMSS-<plugin>-<8hex>`.
// Plugin names can't satisfy this shape because the date prefix is rigid.
const RUN_ID_PATTERN = /^\d{8}T\d{6}-[A-Za-z0-9._-]+-[0-9a-f]{8}$/;

function formatRunDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

async function listRecentRuns(limit: number, verbose: boolean): Promise<void> {
  const runs = await listRuns(limit);
  if (runs.length === 0) {
    console.log("No runs yet. Try `dither plugin run <name>`.");
    return;
  }
  const now = Date.now();
  const rows = runs.map((r) => {
    const rel = formatRelPast(Date.parse(r.startedAt), now);
    const dur = formatRunDuration(r.durationMs);
    const added = `${r.addedCount ?? 0} added`;
    return verbose
      ? [r.runId, r.status, r.plugin, rel, r.startedAt, dur, added]
      : [r.runId, r.status, r.plugin, rel, dur, added];
  });
  const cols = verbose
    ? [{}, {}, {}, {}, {}, { align: "right" as const }, {}]
    : [{}, {}, {}, {}, { align: "right" as const }, {}];
  printTable(rows, cols);
}

export const runsSubcommand = defineCommand({
  meta: {
    name: "runs",
    description:
      "Inspect plugin runs. No arg lists recent runs. A run id tails/replays it. A plugin name tails/replays that plugin's most-recent run.",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description: "Run id or installed plugin name. Omit to list recent runs.",
    },
    limit: {
      type: "string",
      description: "When listing: how many runs to show (default 20).",
      default: "20",
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "When listing: also show the exact ISO start timestamp.",
      default: false,
    },
  },
  async run({ args }) {
    const target = args.target;
    if (target === undefined) {
      await listRecentRuns(Number.parseInt(args.limit, 10) || 20, args.verbose);
      return;
    }
    if (RUN_ID_PATTERN.test(target)) {
      if (!existsSync(join(resolveHome(), "history", target))) {
        process.stderr.write(`no run found with id ${target}\n`);
        process.exit(1);
      }
      await tailRun(target);
      return;
    }
    const last = await findLastRunForPlugin(target);
    if (!last) {
      process.stderr.write(
        `no runs yet for '${target}' — try 'dither plugin run ${target}'\n`,
      );
      process.exit(1);
    }
    await tailRun(last.runId);
  },
});
