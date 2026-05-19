import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHome } from "../home";
import { followRun, listRuns, readRun, type RunResultRecord } from "../run-log";

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

const listSubcommand = defineCommand({
  meta: {
    name: "list",
    description: "List recent plugin runs.",
  },
  args: {
    limit: {
      type: "string",
      description: "How many runs to show (default 20).",
      default: "20",
    },
  },
  async run({ args }) {
    const limit = Number.parseInt(args.limit, 10) || 20;
    const runs = await listRuns(limit);
    if (runs.length === 0) {
      console.log("No runs yet. Try `dither plugin run <name>`.");
      return;
    }
    for (const r of runs) {
      const promoted = r.promotedCount ?? 0;
      console.log(
        `${r.runId}  ${r.status.padEnd(7)} ${r.plugin.padEnd(20)} ` +
          `${r.startedAt}  ${formatDuration(r.durationMs).padStart(7)}  ${promoted} promoted`,
      );
    }
  },
});

function resultPath(runId: string): string {
  return join(resolveHome(), "history", runId, "result.json");
}

async function readResult(runId: string): Promise<RunResultRecord | null> {
  try {
    const raw = await readFile(resultPath(runId), "utf-8");
    return JSON.parse(raw) as RunResultRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const tailSubcommand = defineCommand({
  meta: {
    name: "tail",
    description: "Stream a run's events as they're written.",
  },
  args: {
    runId: {
      type: "positional",
      description: "Run id (from `dither runs list`).",
      required: true,
    },
  },
  async run({ args }) {
    const runId = args.runId;
    const past = await readRun(runId);
    for (const e of past) {
      console.log(JSON.stringify(e));
    }

    // If the run is already finished, surface the result and exit.
    const existing = await readResult(runId);
    if (existing) {
      console.log(JSON.stringify({ type: "_result", ...existing }));
      return;
    }

    const ac = new AbortController();
    const onSig = (): void => ac.abort();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    // Poll for result.json in parallel with the event stream. When it
    // appears, print and abort.
    const resultPoll = setInterval(() => {
      if (existsSync(resultPath(runId))) {
        void readResult(runId).then((r) => {
          if (r) console.log(JSON.stringify({ type: "_result", ...r }));
          ac.abort();
        });
      }
    }, 100);

    try {
      for await (const event of followRun(runId, ac.signal)) {
        console.log(JSON.stringify(event));
      }
    } finally {
      clearInterval(resultPoll);
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
    }
  },
});

export const runsCommand = defineCommand({
  meta: {
    name: "runs",
    description: "Inspect plugin run history.",
  },
  subCommands: {
    list: listSubcommand,
    tail: tailSubcommand,
  },
});
