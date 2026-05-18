import { describe, expect, it } from "vitest";
import { embedLoop, type EmbedCallable } from "./progress";

interface EmbedCallSpec {
  /** Chunks reported as embedded in this call. */
  chunksEmbedded: number;
  /** Initial totalChunks reported via onProgress at the start of this call. */
  totalChunks: number;
  /** Wall-clock duration the call reports. */
  durationMs: number;
  /** Optional truncation warnings to emit via console.warn during this call. */
  truncationWarnings?: number;
}

function fakeStore(calls: EmbedCallSpec[]): {
  store: EmbedCallable;
  invocations: number;
  cumulativeReported: Array<{ cum: number; total: number }>;
} {
  let idx = 0;
  const cumulativeReported: Array<{ cum: number; total: number }> = [];
  const store: EmbedCallable = {
    async embed(opts) {
      const spec = calls[idx]!;
      idx++;
      // Mimic qmd: one initial onProgress at start (current=0, total=N),
      // then a final onProgress at completion (current=N, total=N).
      opts?.onProgress?.({ chunksEmbedded: 0, totalChunks: spec.totalChunks });
      for (let i = 0; i < (spec.truncationWarnings ?? 0); i++) {
        console.warn("⚠ Batch text truncated to fit embedding context (2048 tokens)");
      }
      opts?.onProgress?.({
        chunksEmbedded: spec.chunksEmbedded,
        totalChunks: spec.totalChunks,
      });
      return { chunksEmbedded: spec.chunksEmbedded, durationMs: spec.durationMs };
    },
  };
  return {
    store,
    get invocations() {
      return idx;
    },
    cumulativeReported,
  };
}

describe("embedLoop", () => {
  it("drains in two calls when the first iteration handles everything", async () => {
    // The loop always confirms drainage with a final zero-chunk call —
    // that's how we know there's no more work, since qmd doesn't expose
    // a "are we done" predicate. The second call is a fast no-op for qmd.
    const f = fakeStore([
      { chunksEmbedded: 100, totalChunks: 100, durationMs: 1_000 },
      { chunksEmbedded: 0, totalChunks: 0, durationMs: 5 },
    ]);
    const summary = await embedLoop(f.store);
    expect(f.invocations).toBe(2);
    expect(summary).toEqual({
      chunks: 100,
      durationMs: 1_005,
      truncated: 0,
      iterations: 2,
    });
  });

  it("loops until a call reports zero chunks (session-expiry recovery)", async () => {
    // First call: session expires after 800 of 1820 chunks. Second call
    // resumes with 1020 remaining and finishes 200 before another expiry.
    // Third call finishes the remaining 820. Final call returns 0.
    //
    // Note qmd's actual behavior: when a session aborts mid-embed, the
    // returned chunksEmbedded counts what made it; subsequent calls see
    // a smaller needsEmbedding.
    const f = fakeStore([
      { chunksEmbedded: 800, totalChunks: 1820, durationMs: 600_000 },
      { chunksEmbedded: 200, totalChunks: 1020, durationMs: 600_000 },
      { chunksEmbedded: 820, totalChunks: 820, durationMs: 540_000 },
      { chunksEmbedded: 0, totalChunks: 0, durationMs: 50 },
    ]);
    const summary = await embedLoop(f.store);
    expect(f.invocations).toBe(4);
    expect(summary.chunks).toBe(1820);
    expect(summary.durationMs).toBe(1_740_050);
    expect(summary.iterations).toBe(4);
  });

  it("emits cumulative progress across iterations", async () => {
    const received: Array<{ cum: number; total: number }> = [];
    const f = fakeStore([
      { chunksEmbedded: 800, totalChunks: 1820, durationMs: 100 },
      { chunksEmbedded: 1020, totalChunks: 1020, durationMs: 100 },
      { chunksEmbedded: 0, totalChunks: 0, durationMs: 1 },
    ]);
    await embedLoop(f.store, (cum, total) => {
      received.push({ cum, total });
    });
    // First call: starts at 0/1820, ends at 800/1820.
    expect(received[0]).toEqual({ cum: 0, total: 1820 });
    expect(received[1]).toEqual({ cum: 800, total: 1820 });
    // Second call: starts at 800/1820 (cumulative), ends at 1820/1820.
    // initialTotal was captured as 1820, so denominator stays at 1820 even
    // though qmd's second call reports totalChunks=1020.
    expect(received[2]).toEqual({ cum: 800, total: 1820 });
    expect(received[3]).toEqual({ cum: 1820, total: 1820 });
  });

  it("aggregates truncation counts across iterations", async () => {
    const f = fakeStore([
      { chunksEmbedded: 500, totalChunks: 600, durationMs: 1_000, truncationWarnings: 5 },
      { chunksEmbedded: 100, totalChunks: 100, durationMs: 200, truncationWarnings: 3 },
      { chunksEmbedded: 0, totalChunks: 0, durationMs: 1 },
    ]);
    const summary = await embedLoop(f.store);
    expect(summary.truncated).toBe(8);
  });

  it("returns zeros when the store has nothing to embed", async () => {
    const f = fakeStore([{ chunksEmbedded: 0, totalChunks: 0, durationMs: 5 }]);
    const summary = await embedLoop(f.store);
    expect(f.invocations).toBe(1);
    expect(summary).toEqual({ chunks: 0, durationMs: 5, truncated: 0, iterations: 1 });
  });

  it("caps at 20 iterations as a safety bound against a buggy store", async () => {
    // Pathological store that always reports 1 chunk done — would loop
    // forever without the cap.
    const store: EmbedCallable = {
      async embed() {
        return { chunksEmbedded: 1, durationMs: 1 };
      },
    };
    const summary = await embedLoop(store);
    expect(summary.iterations).toBe(20);
    expect(summary.chunks).toBe(20);
  });
});
