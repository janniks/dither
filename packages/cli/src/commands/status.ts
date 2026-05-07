import { defineCommand } from "citty";
import { getStatus } from "../status";

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Summarize the dither install (home, plugins, collections, entries).",
  },
  args: {
    json: {
      type: "boolean",
      description: "Emit structured JSON instead of human-readable text.",
      default: false,
    },
  },
  async run({ args }) {
    const s = await getStatus();
    if (args.json) {
      console.log(JSON.stringify(s, null, 2));
      return s;
    }
    console.log(`home:        ${s.home}`);
    console.log(`plugins:     ${s.plugins}`);
    console.log(`collections: ${s.collections}`);
    console.log(`entries:     ${s.entries}`);
    if (s.daemon.running) {
      console.log(`daemon:      running (pid ${s.daemon.pid})`);
      if (s.daemon.snapshot) {
        console.log(`  running plugins: ${s.daemon.snapshot.running.length}`);
      }
    } else {
      console.log("daemon:      not running");
    }
    return s;
  },
});
