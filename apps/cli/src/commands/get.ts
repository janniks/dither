import { defineCommand } from "citty";
import { get } from "../get";

function parseLineRange(value: string | undefined): {
  fromLine?: number;
  toLine?: number;
} {
  if (!value) return {};
  const [from, to] = value.split(":").map((s) => s.trim());
  const fromLine = from ? Number.parseInt(from, 10) : undefined;
  const toLine = to ? Number.parseInt(to, 10) : undefined;
  return { fromLine, toLine };
}

export const getCommand = defineCommand({
  meta: {
    name: "get",
    description: "Read an entry by path or docid.",
  },
  args: {
    ref: {
      type: "positional",
      required: true,
      description: "Display path (notes/foo.md) or docid (#abc123)",
    },
    lines: {
      type: "string",
      description: "Line range in `start:end` form (1-based, inclusive)",
    },
  },
  async run({ args }) {
    const { fromLine, toLine } = parseLineRange(args.lines);
    const content = await get({ ref: args.ref, fromLine, toLine });
    if (content !== null) {
      console.log(content);
    }
    return content;
  },
});
