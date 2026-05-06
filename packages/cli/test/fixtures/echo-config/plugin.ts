import { readInput, writeEntry } from "@dither/plugin";

const input = await readInput();

await writeEntry({
  collection: "echoed",
  frontmatter: {
    external_id: "echo-1",
    greeting: input.env.GREETING,
    max_runs: input.env.MAX_RUNS,
  },
  body: [
    "# Echo result",
    "",
    "Greeting: " + input.env.GREETING,
    "Max runs: " + input.env.MAX_RUNS,
    "Token: " + input.env.API_TOKEN,
  ].join("\n"),
});
