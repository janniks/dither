import { defineCommand } from "citty";
import { Cron } from "croner";
import { listPlugins } from "../plugin-list";
import { printTable } from "../prompt";
import { formatRelTime } from "../relative-time";

export const listSubcommand = defineCommand({
  meta: {
    name: "list",
    description: "List installed plugins.",
  },
  async run() {
    const plugins = await listPlugins();
    if (plugins.length === 0) {
      console.log("(no plugins installed)");
      return plugins;
    }
    const rows = plugins.map((p) => {
      const cols = p.collections.length ? p.collections.join(",") : "-";
      const sched = p.schedule ?? "-";
      let next = "";
      if (p.schedule) {
        try {
          const at = new Cron(p.schedule).nextRun();
          if (at) next = formatRelTime(at.getTime());
        } catch {
          // malformed cron — leave next blank rather than crash the list.
        }
      }
      return [p.name, p.version, cols, sched, next];
    });
    // Clamp the collections column so a plugin with many collections
    // doesn't push schedule + next off-screen.
    printTable(rows, [{}, {}, { max: 40 }, {}, {}]);
    return plugins;
  },
});
