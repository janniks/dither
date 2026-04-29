import { defineCommand } from "citty";
import { search } from "../search";

export const searchCommand = defineCommand({
  meta: {
    name: "search",
    description: "Search across your entries.",
  },
  args: {
    query: {
      type: "positional",
      required: true,
      description: "Search query",
    },
    collection: {
      type: "string",
      alias: "c",
      description: "Filter to a single collection",
    },
    limit: {
      type: "string",
      alias: "n",
      description: "Max results",
    },
    rerank: {
      type: "boolean",
      description: "Use the LLM reranker (slower, higher quality)",
    },
    mode: {
      type: "string",
      description: "Search mode: hybrid (default) or lex",
    },
  },
  async run({ args }) {
    const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
    const mode = args.mode === "lex" || args.mode === "hybrid" ? args.mode : undefined;

    const hits = await search({
      query: args.query,
      collection: args.collection,
      limit,
      rerank: args.rerank,
      mode,
    });

    for (const hit of hits) {
      console.log(`${hit.path}\t${hit.score.toFixed(3)}\t${hit.title}`);
    }

    return hits;
  },
});
