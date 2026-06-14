import { extractSnippet } from "@tobilu/qmd";
import { openStore } from "./store";

export interface SearchOptions {
  query: string;
  collection?: string;
  limit?: number;
  /**
   * "hybrid" (default) — BM25 + vector + LLM expansion (requires qmd models).
   * "lex" — BM25 only (no models, no embeddings).
   */
  mode?: "hybrid" | "lex";
  rerank?: boolean;
  /**
   * Attach a snippet from the matched region to each hit. `before`/`after` are
   * grep-style context line counts around the matched line (both 0 → just the
   * matched line). Omit/undefined for no snippet.
   */
  preview?: { before: number; after: number };
}

export interface SearchHit {
  path: string;
  collection: string;
  docid: string;
  title: string;
  score: number;
  /**
   * Present iff `preview` was requested and a snippet could be extracted.
   * `text` may span multiple lines (joined by "\n") when more than one line
   * was requested; `line` is the first line of the window.
   */
  snippet?: { text: string; line: number };
}

export async function search(opts: SearchOptions): Promise<SearchHit[]> {
  const store = await openStore();
  if (!store) {
    return [];
  }

  const mode = opts.mode ?? "hybrid";

  if (mode === "lex") {
    const results = await store.searchLex(opts.query, {
      limit: opts.limit,
      collection: opts.collection,
    });
    return Promise.all(
      results.map(async (r) => {
        const hit: SearchHit = {
          path: r.displayPath,
          collection: r.collectionName,
          docid: r.docid,
          title: r.title,
          score: r.score,
        };
        if (opts.preview) {
          const snippet = await extractLexSnippet(store, r.docid, opts.query, r.chunkPos, opts.preview);
          if (snippet) hit.snippet = snippet;
        }
        return hit;
      }),
    );
  }

  const results = await store.search({
    query: opts.query,
    limit: opts.limit,
    collection: opts.collection,
    rerank: opts.rerank ?? false,
  });
  return results.map((r) => {
    const hit: SearchHit = {
      path: r.displayPath,
      collection: r.context ?? "",
      docid: r.docid,
      title: r.title,
      score: r.score,
    };
    // Hybrid results already carry body + bestChunkPos — no extra DB hit.
    if (opts.preview && r.body) {
      const snippet = safeSnippet(r.body, opts.query, r.bestChunkPos, r.bestChunk?.length, opts.preview);
      if (snippet) hit.snippet = snippet;
    }
    return hit;
  });
}

// Lex hits don't carry the body — fetch it then snippet. Errors silently
// drop the snippet rather than failing the whole hit.
async function extractLexSnippet(
  store: NonNullable<Awaited<ReturnType<typeof openStore>>>,
  docid: string,
  query: string,
  chunkPos: number | undefined,
  ctx: { before: number; after: number },
): Promise<{ text: string; line: number } | undefined> {
  try {
    const body = await store.getDocumentBody(docid);
    if (!body) return undefined;
    return safeSnippet(body, query, chunkPos, undefined, ctx);
  } catch {
    return undefined;
  }
}

// Cut a grep-style window: `before` lines above and `after` lines below the
// matched line (always included), clamped at file edges. Blank lines at the
// window's edges are trimmed so previews don't lead/trail with empty rows;
// trailing whitespace and the window's common leading indent are stripped so
// the snippet reads flush-left while keeping relative structure. Returns the
// joined text and the window's start line.
function window(all: string[], idx: number, before: number, after: number): { text: string; start: number } | undefined {
  let start = Math.max(0, idx - before);
  let end = Math.min(all.length - 1, idx + after);
  while (start < idx && all[start]!.trim() === "") start++;
  while (end > idx && all[end]!.trim() === "") end--;
  const slice = all.slice(start, end + 1).map((l) => l.replace(/\s+$/, ""));
  const indents = slice.filter((l) => l !== "").map((l) => l.match(/^\s*/)![0].length);
  const dedent = indents.length > 0 ? Math.min(...indents) : 0;
  const text = slice.map((l) => l.slice(dedent)).join("\n");
  return text.trim() ? { text, start } : undefined;
}

export function safeSnippet(
  body: string,
  query: string,
  chunkPos: number | undefined,
  chunkLen: number | undefined,
  ctx: { before: number; after: number } = { before: 0, after: 0 },
): { text: string; line: number } | undefined {
  if (!body) return undefined;
  const all = body.split("\n");

  // qmd returns the matched line index + a multi-line `snippet` with a
  // diff-style `@@ -X,Y @@` header — we want neither format, just the line
  // index so we can cut our own window from the body.
  const idx = (() => {
    try {
      const s = extractSnippet(body, query, undefined, chunkPos, chunkLen);
      if (all[s.line - 1]?.trim()) return s.line - 1;
    } catch {
      // fall through
    }
    // Fallback: no match in the chunk (all stopwords, empty result, or qmd
    // threw). Anchor on the first non-empty line so the preview still shows
    // context instead of going missing.
    return all.findIndex((l) => l.trim() !== "");
  })();
  if (idx < 0) return undefined;

  const win = window(all, idx, Math.max(0, ctx.before), Math.max(0, ctx.after));
  if (!win) return undefined;
  return { text: win.text, line: win.start + 1 };
}
