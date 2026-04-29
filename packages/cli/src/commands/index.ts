import { defineCommand } from "citty";
import { updateIndex } from "../update-index";

const updateSubcommand = defineCommand({
  meta: {
    name: "update",
    description: "Re-scan ~/.dither/entries/ and refresh the qmd index.",
  },
  async run() {
    const result = await updateIndex();
    console.log(
      `index updated: ${result.collections} collection(s), ` +
        `${result.indexed} indexed, ${result.updated} updated`,
    );
    return result;
  },
});

export const indexCommand = defineCommand({
  meta: {
    name: "index",
    description: "Index management.",
  },
  subCommands: {
    update: updateSubcommand,
  },
});
