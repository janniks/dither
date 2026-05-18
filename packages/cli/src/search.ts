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
  /** Attach a one-line snippet from the matched region to each hit. */
  preview?: boolean;
}

export interface SearchHit {
  path: string;
  collection: string;
  docid: string;
  title: string;
  score: number;
  /** Present iff `preview: true` was passed and a snippet could be extracted. */
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
          const snippet = await extractLexSnippet(store, r.docid, opts.query, r.chunkPos);
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
  return results.map((r) => ({
    path: r.displayPath,
    collection: r.context ?? "",
    docid: r.docid,
    title: r.title,
    score: r.score,
  }));
}

// Lex hits don't carry the body — fetch it and run extractSnippet. Errors
// (missing file, empty body, qmd throwing) silently drop the snippet rather
// than failing the whole hit.
async function extractLexSnippet(
  store: NonNullable<Awaited<ReturnType<typeof openStore>>>,
  docid: string,
  query: string,
  chunkPos: number | undefined,
): Promise<{ text: string; line: number } | undefined> {
  try {
    const body = await store.getDocumentBody(docid);
    if (!body) return undefined;
    const s = extractSnippet(body, query, undefined, chunkPos);
    if (!s.snippet) return undefined;
    return { text: s.snippet, line: s.line };
  } catch {
    return undefined;
  }
}
