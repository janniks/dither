import { defineCommand } from "citty";
import { getStatus, type DitherStatus } from "../status";

const fmt = (n: number): string => new Intl.NumberFormat(undefined).format(n);

function printHumanStatus(s: DitherStatus): void {
  // Optional header — only when the user explicitly overrode via env.
  if (s.configDirSource === "env") {
    console.log(`DITHER_DIR=${s.configDir}`);
    console.log("");
  }

  // Locations.
  console.log(`config dir:  ${s.configDir}`);
  if (s.libraryHealth === "unconfigured") {
    console.log("library:     (not configured — run `dither init`)");
  } else if (s.libraryHealth === "missing") {
    console.log(`library:     ${s.library}  ⚠ missing — directory does not exist`);
  } else if (s.libraryHealth === "unreadable") {
    console.log(`library:     ${s.library}  ⚠ unreadable — directory exists but is not readable`);
  } else {
    console.log(`library:     ${s.library}`);
  }
  console.log("");

  // Content.
  console.log(`plugins:     ${fmt(s.plugins)}`);
  const ctx =
    s.libraryHealth === "missing"
      ? "  (library missing)"
      : s.libraryHealth === "unreadable"
        ? "  (library unreadable)"
        : s.libraryHealth === "unconfigured"
          ? "  (library not configured)"
          : "";
  console.log(`collections: ${s.collections === null ? "—" : fmt(s.collections)}`);
  console.log(`entries:     ${s.entries === null ? "—" : fmt(s.entries)}${ctx}`);
  console.log("");

  // Runtime.
  if (s.daemon.running) {
    console.log(`daemon:      running (pid ${s.daemon.pid})`);
    if (s.daemon.snapshot) {
      console.log(`  running plugins: ${s.daemon.snapshot.running.length}`);
    }
  } else {
    console.log("daemon:      not running");
  }
}

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
    printHumanStatus(s);
    return s;
  },
});
