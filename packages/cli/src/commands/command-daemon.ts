import { defineCommand } from "citty";
import { createReadStream, watch as fsWatch, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { daemonLogPath } from "../home";
import { assertInitialized } from "../config";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  reloadDaemon,
  formatProbeReason,
} from "../daemon-control";
import { runDaemon } from "../daemon";
import { formatRelTime } from "../relative-time";

const PREVIEW_LIMIT = 4;

// Print up to PREVIEW_LIMIT entries; if more exist, append "..." so the
// caller knows the printed list is a preview, not the full set.
function printPreview<T>(items: readonly T[], format: (item: T) => string): void {
  for (const item of items.slice(0, PREVIEW_LIMIT)) console.log(format(item));
  if (items.length > PREVIEW_LIMIT) console.log("  - ...");
}

const startSubcommand = defineCommand({
  meta: {
    name: "start",
    description: "Start the dither daemon (detached).",
  },
  async run() {
    await assertInitialized();
    const result = await startDaemon();
    if (result.alreadyRunning) {
      console.log(`Daemon already running (pid ${result.pid}).`);
    } else {
      console.log(`Daemon started (pid ${result.pid}).`);
    }
  },
});

const stopSubcommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the dither daemon (SIGTERM, up to 35s wait).",
  },
  async run() {
    const result = await stopDaemon();
    if (!result.pid) {
      console.log("Daemon is not running.");
      return;
    }
    if (result.stopped) {
      console.log(`Daemon stopped (was pid ${result.pid}).`);
    } else {
      console.log(`Daemon (pid ${result.pid}) did not exit within timeout.`);
      process.exitCode = 1;
    }
  },
});

const statusSubcommand = defineCommand({
  meta: {
    name: "status",
    description: "Show daemon status.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Emit structured JSON instead of human-readable text.",
      default: false,
    },
  },
  async run({ args }) {
    const s = await getDaemonStatus();
    if (args.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    if (!s.running) {
      const why = formatProbeReason(s.reason);
      console.log(`daemon: not running${why ? ` (${why})` : ""}`);
      if (s.pid) console.log(`pid:    ${s.pid}`);
      if (s.snapshot) {
        console.log(`startedAt: ${s.snapshot.startedAt}`);
        console.log(`lastUpdated:  ${s.snapshot.lastUpdated}`);
      }
      return;
    }
    console.log(`daemon:      running (pid ${s.pid})`);
    if (s.snapshot) {
      console.log(`startedAt:   ${s.snapshot.startedAt}`);
      console.log(`lastUpdated: ${s.snapshot.lastUpdated}`);
      console.log(`schedules:   ${s.snapshot.schedules}`);
      printPreview(s.snapshot.scheduleEntries, (e) => {
        const next = e.nextRun ? formatRelTime(Date.parse(e.nextRun)) : "—";
        return `  - ${e.name}: ${e.pattern} (next ${next})`;
      });
      console.log(`watches:     ${s.snapshot.watches}`);
      printPreview(s.snapshot.watchEntries, (e) =>
        `  - ${e.name}: ${e.collections.join(", ")} ${e.glob}`,
      );
      console.log(`running:     ${s.snapshot.running.length}`);
      for (const r of s.snapshot.running) {
        console.log(`  - ${r.name} (pid ${r.pid})`);
      }
      if (s.snapshot.recentHalts.length) {
        console.log(`halts:       ${s.snapshot.recentHalts.length}`);
        printPreview(s.snapshot.recentHalts, (h) =>
          `  - ${h.pluginName} via ${h.triggerSource} @ depth ${h.depth} (${h.at})`,
        );
      }
      const failures = s.snapshot.recentRuns.filter((r) => r.status === "fail");
      if (failures.length) {
        console.log(`failures:    ${failures.length} recent`);
        printPreview(failures, (f) => `  - ${f.plugin} (${f.runId})`);
      }
    } else {
      console.log("snapshot:    (not yet written)");
    }
  },
});

const reloadSubcommand = defineCommand({
  meta: {
    name: "reload",
    description: "Send SIGHUP to the daemon (reload schedules in later phases).",
  },
  async run() {
    const ok = await reloadDaemon();
    console.log(ok ? "Reload signal sent." : "Daemon is not running.");
  },
});

const logsSubcommand = defineCommand({
  meta: {
    name: "logs",
    description: "Tail the daemon log.",
  },
  args: {
    follow: {
      type: "boolean",
      alias: "f",
      description: "Follow new log lines until interrupted.",
      default: false,
    },
  },
  async run({ args }) {
    const path = daemonLogPath();
    if (!existsSync(path)) {
      console.log(`No daemon log yet at ${path}.`);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path, { encoding: "utf-8" });
      stream.on("data", (chunk) => process.stdout.write(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    if (!args.follow) return;

    let offset = (await stat(path)).size;
    return new Promise<void>((resolve) => {
      const watcher = fsWatch(path, async () => {
        const cur = await stat(path).catch(() => null);
        if (!cur || cur.size <= offset) return;
        const stream = createReadStream(path, {
          encoding: "utf-8",
          start: offset,
          end: cur.size - 1,
        });
        offset = cur.size;
        stream.on("data", (chunk) => process.stdout.write(chunk));
      });
      const onSig = () => {
        watcher.close();
        resolve();
      };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);
    });
  },
});

const runSubcommand = defineCommand({
  meta: {
    name: "run",
    description: "(internal) Run the daemon main loop in this process.",
    hidden: true,
  },
  // Intentionally no assertInitialized() here: this subcommand is the
  // detached process spawned by daemon-control after `daemon start` already
  // checked. Direct hand-invocation without init is allowed to fail fast on
  // the first reconcile() — see notes/qmd-library-edge-cases.md (#4).
  async run() {
    await runDaemon();
  },
});

const reconcileSubcommand = defineCommand({
  meta: {
    name: "reconcile",
    description: "(internal) Run one qmd reconcile (index + embed) in this process.",
    hidden: true,
  },
  // Like `run`: no assertInitialized() — this is the child the daemon
  // spawns (Phase 3) after init was already checked. Hand-invoked without
  // a library, qmdReconcile exits clean on the no-library path.
  //
  // Dynamic import so loading this command module (and `daemon run`, its
  // sibling) doesn't eagerly pull qmd natives (openStore/embedLoop) via
  // reconcile-run. Only this child process loads them.
  async run() {
    const { runReconcileChild } = await import("../reconcile-run");
    await runReconcileChild();
  },
});

export const daemonCommand = defineCommand({
  meta: {
    name: "daemon",
    description: "Manage the long-lived dither daemon.",
  },
  subCommands: {
    start: startSubcommand,
    stop: stopSubcommand,
    status: statusSubcommand,
    reload: reloadSubcommand,
    logs: logsSubcommand,
    run: runSubcommand,
    reconcile: reconcileSubcommand,
  },
});
