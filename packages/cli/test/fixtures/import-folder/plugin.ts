import { writeEntry } from "@dither/plugin";

await writeEntry({
  collection: "imported",
  frontmatter: {
    external_id: "fixture-1",
    title: "Hello from fixture",
  },
  body: "# Hello\n\nThis entry was emitted via the @dither/plugin SDK.",
});
