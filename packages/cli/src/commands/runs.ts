import { defineCommand } from "citty";
import { listRuns, readEvents, tailRun } from "../journal";

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
    const past = await readEvents(runId);
    for (const e of past) {
      console.log(JSON.stringify(e));
    }

    return new Promise<void>((resolve, reject) => {
      let handle: { stop: () => Promise<void> } | null = null;
      const onSig = () => {
        void handle?.stop().then(() => resolve());
      };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);

      tailRun(
        runId,
        (event) => console.log(JSON.stringify(event)),
        (result) => {
          console.log(JSON.stringify({ type: "_result", ...result }));
          process.off("SIGINT", onSig);
          process.off("SIGTERM", onSig);
          resolve();
        },
      ).then(
        (h) => {
          handle = h;
        },
        (err) => reject(err),
      );
    });
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
