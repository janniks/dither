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
}

export interface SearchHit {
  path: string;
  collection: string;
  docid: string;
  title: string;
  score: number;
}

export async function search(opts: SearchOptions): Promise<SearchHit[]> {
  const store = await openStore();
  if (!store) {
    return [];
  }

  try {
    const mode = opts.mode ?? "hybrid";

    if (mode === "lex") {
      const results = await store.searchLex(opts.query, {
        limit: opts.limit,
        collection: opts.collection,
      });
      return results.map((r) => ({
        path: r.displayPath,
        collection: r.collectionName,
        docid: r.docid,
        title: r.title,
        score: r.score,
      }));
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
  } finally {
    // qmd's QMDStore doesn't expose close(); the underlying store is GC'd.
  }
}
