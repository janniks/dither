import { defineCommand } from "citty";
import pc from "picocolors";
import { getStatus, type DitherStatus } from "../status";

const fmt = (n: number): string => new Intl.NumberFormat(undefined).format(n);

function printHumanStatus(s: DitherStatus): void {
  // Optional header — only when the user explicitly overrode via env.
  if (s.configDirSource === "env") {
    console.log(`${pc.cyan("Note:")} Using ENV DITHER_DIR=${s.configDir}`);
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

  // Runtime. Three states on one line:
  //   idle (pid 14675)                     ← daemon up, 0 plugins running
  //   running (pid 14675, 1 plugin)        ← daemon up, 1 plugin running
  //   running (pid 14675, 3 plugins)       ← daemon up, N>0 plugins
  //   running (pid 14675)                  ← snapshot unavailable; assume up
  //   not running                          ← daemon down
  if (s.daemon.running) {
    const n = s.daemon.snapshot?.running.length ?? -1;
    let label: string;
    if (n === 0) {
      label = `idle (pid ${s.daemon.pid})`;
    } else if (n > 0) {
      label = `running (pid ${s.daemon.pid}, ${n} plugin${n === 1 ? "" : "s"})`;
    } else {
      label = `running (pid ${s.daemon.pid})`;
    }
    console.log(`daemon:      ${pc.green(label)}`);
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
