import { defineCommand } from "citty";
import pc from "picocolors";
import { getStatus, type DitherStatus } from "../status";
import { formatProbeReason } from "../daemon-control";
import { tildePath } from "../prompt";
import { formatRelPast } from "../relative-time";

const fmt = (n: number): string => new Intl.NumberFormat(undefined).format(n);

function printHumanStatus(s: DitherStatus): void {
  // Optional header — only when the user explicitly overrode via env.
  if (s.configDirSource === "env") {
    console.log(`${pc.cyan("Note:")} Using ENV DITHER_DIR=${tildePath(s.configDir)}`);
    console.log("");
  }

  // Locations.
  console.log(`config dir:  ${tildePath(s.configDir)}`);
  if (s.libraryHealth === "unconfigured") {
    console.log(`library:     ${pc.dim("(not configured — run `dither init`)")}`);
  } else if (s.libraryHealth === "missing") {
    console.log(
      `library:     ${tildePath(s.library!)}  ${pc.yellow("⚠ missing — directory does not exist")}`,
    );
  } else if (s.libraryHealth === "unreadable") {
    console.log(
      `library:     ${tildePath(s.library!)}  ${pc.yellow("⚠ unreadable — directory exists but is not readable")}`,
    );
  } else {
    console.log(`library:     ${tildePath(s.library!)}`);
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
    const stamp = s.daemon.snapshot?.lastUpdated;
    if (stamp) {
      const ago = formatRelPast(Date.parse(stamp));
      console.log(`             ${pc.dim(`status updated ${ago}`)}`);
    }
  } else {
    const why = formatProbeReason(s.daemon.reason);
    const tail = why ? pc.dim(` (${why})`) : "";
    console.log(`daemon:      ${pc.dim("not running")}${tail}`);
  }

  // qmd job state. Quiet when idle + no recent activity; shows current
  // job inline, recent jobs as one line each, and marker hints.
  const j = s.jobs;
  const hasContent =
    j.current.length > 0 || j.recent.length > 0 || j.needsReindex || j.embedDisabled;
  if (hasContent) {
    console.log("");
    if (j.current.length === 0) {
      console.log(`current:     ${pc.dim("none")}`);
    } else {
      for (const c of j.current) {
        const progress =
          typeof c.current === "number" && typeof c.total === "number" && c.total > 0
            ? ` ${c.current}/${c.total}`
            : "";
        const elapsed = Math.round((Date.now() - new Date(c.startedAt).getTime()) / 1000);
        console.log(
          `current:     ${pc.green(c.type)}${progress}  ${pc.dim(`(${elapsed}s)`)}`,
        );
      }
    }
    if (j.recent.length > 0) {
      console.log("recent:");
      for (const r of j.recent.slice(-5)) {
        let label = `${pc.dim("✓")} ${r.type}`;
        if (r.type === "indexing" && typeof r.filesIndexed === "number") {
          label = `${pc.dim("✓")} indexed ${fmt(r.filesIndexed)} file${r.filesIndexed === 1 ? "" : "s"}`;
        } else if (r.type === "embedding" && typeof r.chunks === "number") {
          const trunc = r.truncated && r.truncated > 0 ? ` (${r.truncated} truncated)` : "";
          label = `${pc.dim("✓")} embedded ${fmt(r.chunks)} chunks${trunc}`;
        } else if (r.type === "model-download") {
          label = `${pc.dim("✓")} model-download`;
        }
        if (r.failed) label = `${pc.yellow("⚠")} ${r.type} failed: ${r.failed}`;
        if (r.skipped) label = `${pc.dim("⊘")} ${r.type} skipped (${r.skipped})`;
        console.log(`  ${label}`);
      }
    }
    if (j.needsReindex) {
      console.log(`             ${pc.dim("needs-reindex pending")}`);
    }
    if (j.embedDisabled) {
      console.log(
        `             ${pc.dim("embed-disabled (run `dither index update` to resume)")}`,
      );
    }
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
