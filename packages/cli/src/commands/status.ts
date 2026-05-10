import { defineCommand } from "citty";
import pc from "picocolors";
import { getStatus, type DitherStatus } from "../status";

const fmt = (n: number): string => new Intl.NumberFormat(undefined).format(n);

function printHumanStatus(s: DitherStatus): void {
  // Optional header — only when the user explicitly overrode via env.
  if (s.configDirSource === "env") {
    console.log(`${pc.bold(pc.cyan("DITHER_DIR"))}=${s.configDir}`);
    console.log("");
  }

  // Locations.
  console.log(`config dir:  ${s.configDir}`);
  if (s.libraryHealth === "unconfigured") {
    console.log(`library:     ${pc.dim("(not configured — run `dither init`)")}`);
  } else if (s.libraryHealth === "missing") {
    console.log(
      `library:     ${s.library}  ${pc.yellow("⚠ missing — directory does not exist")}`,
    );
  } else if (s.libraryHealth === "unreadable") {
    console.log(
      `library:     ${s.library}  ${pc.yellow("⚠ unreadable — directory exists but is not readable")}`,
    );
  } else {
    console.log(`library:     ${s.library}`);
  }
  console.log("");

  // Content.
  console.log(`plugins:     ${fmt(s.plugins)}`);
  const ctx =
    s.libraryHealth === "missing"
      ? `  ${pc.dim("(library missing)")}`
      : s.libraryHealth === "unreadable"
        ? `  ${pc.dim("(library unreadable)")}`
        : s.libraryHealth === "unconfigured"
          ? `  ${pc.dim("(library not configured)")}`
          : "";
  const collectionsCell = s.collections === null ? pc.dim("—") : fmt(s.collections);
  const entriesCell = s.entries === null ? pc.dim("—") : fmt(s.entries);
  console.log(`collections: ${collectionsCell}`);
  console.log(`entries:     ${entriesCell}${ctx}`);
  console.log("");

  // Runtime.
  if (s.daemon.running) {
    console.log(`daemon:      ${pc.green(`running (pid ${s.daemon.pid})`)}`);
    if (s.daemon.snapshot) {
      console.log(`  running plugins: ${s.daemon.snapshot.running.length}`);
    }
  } else {
    console.log(`daemon:      ${pc.dim("not running")}`);
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
