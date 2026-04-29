import { defineCommand } from "citty";
import { getStatus } from "../status";

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Summarize the dither install (home, plugins, collections, entries).",
  },
  async run() {
    const s = await getStatus();
    console.log(`home:        ${s.home}`);
    console.log(`plugins:     ${s.plugins}`);
    console.log(`collections: ${s.collections}`);
    console.log(`entries:     ${s.entries}`);
    return s;
  },
});
