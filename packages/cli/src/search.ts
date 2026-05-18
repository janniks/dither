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
      const snippet = safeSnippet(r.body, opts.query, r.bestChunkPos, r.bestChunk?.length);
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
): Promise<{ text: string; line: number } | undefined> {
  try {
    const body = await store.getDocumentBody(docid);
    if (!body) return undefined;
    return safeSnippet(body, query, chunkPos, undefined);
  } catch {
    return undefined;
  }
}

export function safeSnippet(
  body: string,
  query: string,
  chunkPos: number | undefined,
  chunkLen: number | undefined,
): { text: string; line: number } | undefined {
  if (!body) return undefined;
  const lines = body.split("\n");
  try {
    // qmd returns the matched line index + a multi-line `snippet` with a
    // diff-style `@@ -X,Y @@` header. We don't want either format for an
    // inline terminal preview — just pluck the matched line itself.
    const s = extractSnippet(body, query, undefined, chunkPos, chunkLen);
    const matched = lines[s.line - 1]?.trim();
    if (matched) return { text: matched, line: s.line };
  } catch {
    // fall through
  }
  // Fallback: no match in the chunk (all stopwords, empty result, or qmd
  // threw). Pick the first non-empty line so the preview still shows
  // context instead of going missing.
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed) return { text: trimmed, line: i + 1 };
  }
  return undefined;
}
