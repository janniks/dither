import { readFile, writeEntry } from "@dither/plugin";

const body = await readFile("SOURCE");

await writeEntry({
  collection: "read",
  frontmatter: { external_id: "from-file" },
  body,
});
