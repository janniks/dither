import { readFile } from "node:fs/promises";
import { readInput, writeEntry } from "@dither/plugin";

const input = await readInput();
const sourcePath = input.files.SOURCE;
if (!sourcePath) {
  throw new Error("input.files.SOURCE missing");
}

const body = await readFile(sourcePath, "utf-8");

await writeEntry({
  collection: "read",
  frontmatter: { external_id: "from-file", source_path: sourcePath },
  body,
});
