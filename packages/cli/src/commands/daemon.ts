import { defineCommand } from "citty";
import { createReadStream, watch as fsWatch, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { daemonLogPath } from "../home";
import { startDaemon, stopDaemon, getDaemonStatus, reloadDaemon } from "../daemon-control";
import { runDaemon } from "../daemon";

const startSubcommand = defineCommand({
  meta: {
    name: "start",
    description: "Start the dither daemon (detached).",
  },
  async run() {
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
      console.log("daemon: not running");
      return;
    }
    console.log(`daemon:      running (pid ${s.pid})`);
    if (s.snapshot) {
      console.log(`startedAt:   ${s.snapshot.startedAt}`);
      console.log(`lastTick:    ${s.snapshot.lastTick}`);
      console.log(`schedules:   ${s.snapshot.schedules}`);
      console.log(`watches:     ${s.snapshot.watches}`);
      console.log(`running:     ${s.snapshot.running.length}`);
      for (const r of s.snapshot.running) {
        console.log(`  - ${r.name} (pid ${r.pid})`);
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
  async run() {
    await runDaemon();
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
  },
});
