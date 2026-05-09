import { defineCommand } from "citty";
import { getStatus } from "../status";

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description:
      "Summarize the dither install (config dir, library, plugins, collections, entries).",
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
    // Two-row split — surfaces the conceptual separation between
    // dither's working directory and the user's content library.
    console.log(`config dir:  ${s.configDir}`);
    console.log("  (env: DITHER_DIR)");
    if (s.library) {
      console.log(`library:     ${s.library}`);
      console.log("  (config: library.path — set by `dither init --library`)");
    } else {
      console.log("library:     (not configured — run `dither init`)");
    }
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
