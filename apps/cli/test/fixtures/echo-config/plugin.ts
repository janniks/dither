import { readInput, writeEntry } from "@dither/plugin";

interface Config {
  GREETING: string;
  MAX_RUNS: number;
}
interface Secrets {
  API_TOKEN: string;
}

const input = await readInput<Config, Secrets>();

await writeEntry({
  collection: "echoed",
  frontmatter: {
    external_id: "echo-1",
    greeting: input.config.GREETING,
    max_runs: input.config.MAX_RUNS,
  },
  body: [
    "# Echo result",
    "",
    "Greeting: " + input.config.GREETING,
    "Max runs: " + input.config.MAX_RUNS,
    "Token: " + input.secrets.API_TOKEN,
  ].join("\n"),
});
