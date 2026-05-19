import { defineCommand } from "citty";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { search, type SearchHit } from "../search";
import { qmdLockPath } from "../qmd-locks";
import { assertInitialized } from "../config";

// Collapse whitespace and trim — titles can contain newlines or tweet bodies.
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  return `${s.slice(0, max - 1)}…`;
}

// Whitespace-tokenize the raw query into the terms that get bolded inside
// the snippet. Lowercased and length-filtered to avoid pathological regexes
// (`q ` would otherwise match every position).
function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    ),
  );
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}

// Walk the snippet, wrapping matched query terms with `bold` and the
// surrounding text with `dim`. Pure: bold/dim are injected so the function
// is testable without ANSI/picocolors. Word boundaries (`\b`) prevent
// highlighting fragments inside larger words ("rank" doesn't match
// "Rankings").
export function markTerms(
  text: string,
  terms: string[],
  bold: (s: string) => string,
  dim: (s: string) => string,
): string {
  if (terms.length === 0) return text;
  const pattern = new RegExp(`\\b(${terms.map(escapeRegex).join("|")})\\b`, "gi");
  let out = "";
  let i = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > i) out += dim(text.slice(i, start));
    out += bold(m[0]);
    i = start + m[0].length;
  }
  if (i === 0) return text; // no matches — leave raw, caller decides on dim
  if (i < text.length) out += dim(text.slice(i));
  return out;
}

// Render the snippet for terminal output: collapse whitespace, clip to
// width, then highlight query terms. Defaults to picocolors-driven
// formatters but accepts plain identity functions for tests / NO_COLOR.
export function renderSnippet(
  text: string,
  terms: string[],
  maxWidth: number,
  useColor: boolean = pc.isColorSupported,
): string {
  const clipped = truncate(oneLine(text), maxWidth);
  if (!useColor) return clipped;
  return markTerms(clipped, terms, pc.bold, pc.dim);
}

// Render the bare hash. `d get` accepts both `abc123` and `#abc123` (qmd's
// findDocument calls normalizeDocid), but the bare form is shell-safe — zsh
// treats a leading `#` as a comment and silently drops the argument.
function printHits(hits: SearchHit[], query: string): void {
  if (hits.length === 0) return;

  const tty = process.stdout.isTTY;

  // Piped output: stable tab-separated format. Lead with docid since it's the
  // copy-paste get-key; path follows for human context. When a snippet is
  // attached (--preview), append it as a 6th column. One row per hit.
  if (!tty) {
    for (const hit of hits) {
      const base = `${hit.docid}\t${hit.score.toFixed(3)}\t${hit.collection}\t${hit.path}\t${oneLine(hit.title)}`;
      console.log(hit.snippet ? `${base}\t${oneLine(hit.snippet.text)}` : base);
    }
    return;
  }

  const width = process.stdout.columns ?? 80;
  const scoreW = 5; // "1.000"
  const gap = "  ";
  const docidW = Math.max(...hits.map((h) => h.docid.length));
  const collW = Math.max(...hits.map((h) => h.collection.length));
  const titleW = Math.max(0, width - scoreW - gap.length * 3 - docidW - collW);

  // Preview rows align under the title column so the snippet reads as a
  // continuation of the hit, not a fresh row anchored at score.
  const previewIndent = " ".repeat(scoreW + gap.length * 3 + docidW + collW);
  const previewW = Math.max(0, width - previewIndent.length);
  const terms = queryTerms(query);

  for (const hit of hits) {
    const score = pc.dim(hit.score.toFixed(3).padStart(scoreW));
    const docid = pc.cyan(hit.docid.padEnd(docidW));
    const collection = pc.dim(hit.collection.padEnd(collW));
    const title = truncate(oneLine(hit.title), titleW);
    console.log(`${score}${gap}${docid}${gap}${collection}${gap}${title}`);
    if (hit.snippet) {
      console.log(`${previewIndent}${renderSnippet(hit.snippet.text, terms, previewW)}`);
    }
  }
}

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
    preview: {
      type: "boolean",
      alias: "p",
      description: "Show a one-line snippet of the matched region under each hit",
    },
  },
  async run({ args }) {
    await assertInitialized();
    const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
    const mode = args.mode === "lex" || args.mode === "hybrid" ? args.mode : undefined;

    const hits = await search({
      query: args.query,
      collection: args.collection,
      limit,
      rerank: args.rerank,
      mode,
      preview: args.preview,
    });

    printHits(hits, args.query);

    // Footer: warn the user that an embedding pass is still in flight,
    // so partial vector results aren't mistaken for "the doc isn't
    // there." Cheap: one stat call. Doesn't fire when no embed lock is
    // held (the common case).
    if (existsSync(qmdLockPath("embed"))) {
      console.log("");
      console.log(
        pc.dim(
          "note: embedding still in progress. some results may be missing — re-run when done.",
        ),
      );
    }

    return hits;
  },
});
