import { readInput, writeEntry } from "@dither/plugin";

const input = await readInput();
let n = 0;
for (const t of input.targets ?? []) {
  await writeEntry({
    collection: "echoed",
    frontmatter: { id: `t${n++}`, target: t.path },
    body: `saw ${t.path}`,
  });
}
