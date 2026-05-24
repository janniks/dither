import pc from "picocolors";

/**
 * Single-line live progress for slow CLI work. On a TTY it rewrites itself
 * in place via `\r` + EL (erase-in-line); on non-TTY it prints a fresh line
 * every 10% bucket so CI logs still get a heartbeat.
 *
 * Pair with qmd's `onProgress` callbacks: `update(info.current, info.total)`
 * each tick, then `done("<final summary>")` once. `done` clears the live
 * line and prints a `✓ <message>` so only the summary survives in
 * scrollback — the in-progress text never sticks.
 */
export class ProgressLine {
  private readonly label: string;
  private readonly startedAt: number;
  private lastReportedBucket = -1;
  private rendered = false;

  constructor(label: string) {
    this.label = label;
    this.startedAt = Date.now();
    if (isTTY()) {
      process.stdout.write(`${pc.dim("→")} ${label} (starting…)`);
      this.rendered = true;
    } else {
      process.stdout.write(`${pc.dim("→")} ${label}\n`);
    }
  }

  update(current: number, total: number): void {
    const pct = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0;
    const elapsed = Date.now() - this.startedAt;
    // Suppress the first two ticks — the initial sample is too noisy.
    const etaSec =
      current >= 3 && current < total
        ? Math.round((elapsed * (total - current)) / current / 1000)
        : null;
    const etaPart = etaSec !== null && etaSec > 0 ? ` · ~${formatDuration(etaSec * 1000)} remaining` : "";
    const line = `${pc.dim("→")} ${this.label}  ${current}/${total} (${pct}%)${etaPart}`;

    if (isTTY()) {
      // \r returns to col 0; \x1b[2K clears the whole line — handles the case
      // where the previous frame was longer than the new one.
      process.stdout.write(`\r\x1b[2K${line}`);
      this.rendered = true;
      return;
    }

    // Non-TTY: log every 10% bucket and on completion.
    const bucket = Math.floor(pct / 10);
    if (bucket !== this.lastReportedBucket || current === total) {
      process.stdout.write(`${line}\n`);
      this.lastReportedBucket = bucket;
    }
  }

  done(message: string): void {
    if (isTTY() && this.rendered) {
      process.stdout.write(`\r\x1b[2K`);
    }
    process.stdout.write(`${pc.green("✓")} ${message}\n`);
  }
}

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * `1234ms` → `"1s"`, `75000ms` → `"1m 15s"`. Whole-second granularity is
 * enough for ETAs and durations in init — sub-second precision would jitter.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Minimal shape of qmd's `store.embed()` we depend on. Decoupled from the
 * full `QMDStore` type so `embedLoop` is testable with a hand-rolled stub.
 */
export interface EmbedCallable {
  embed(opts?: {
    onProgress?: (info: { chunksEmbedded: number; totalChunks: number }) => void;
  }): Promise<{ chunksEmbedded: number; durationMs: number }>;
}

export interface EmbedLoopResult {
  chunks: number;
  durationMs: number;
  truncated: number;
  iterations: number;
}

/**
 * qmd's internal `LLMSession` has a hardcoded 10-minute max duration
 * (`@tobilu/qmd/dist/llm.js:1049`). Libraries with enough chunks to exceed
 * that get the session aborted with a `Session expired — skipping N
 * remaining chunks` warning, leaving rows still marked needs-embedding in
 * SQLite. qmd's SDK doesn't expose `maxDuration`, so we dodge the ceiling
 * by re-running `embed()` until a call reports it embedded zero chunks —
 * each iteration gets a fresh session.
 *
 * `onProgress` fires with *cumulative* counts so a long embed renders as a
 * single bar that doesn't reset on each retry. Truncation warnings are
 * filtered per-call and summed.
 *
 * The 20-iteration safety cap is a guard against a buggy qmd reporting
 * `chunksEmbedded > 0` forever — at typical throughput that's >100k
 * chunks of real work, well past any realistic library.
 */
const EMBED_LOOP_MAX_ITERATIONS = 20;

export async function embedLoop(
  store: EmbedCallable,
  onProgress?: (embedded: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<EmbedLoopResult> {
  let embedded = 0;
  let duration = 0;
  let truncated = 0;
  let total: number | null = null;
  let iterations = 0;

  while (iterations < EMBED_LOOP_MAX_ITERATIONS) {
    if (shouldCancel?.()) break;
    iterations++;
    const { result, truncatedCount } = await withTruncationFilter(async () =>
      store.embed({
        onProgress: ({ chunksEmbedded, totalChunks }) => {
          if (total === null && totalChunks > 0) total = totalChunks;
          const denom = Math.max(total ?? totalChunks, embedded + totalChunks);
          onProgress?.(Math.min(embedded + chunksEmbedded, denom), denom);
        },
      }),
    );
    embedded += result.chunksEmbedded;
    duration += result.durationMs;
    truncated += truncatedCount;
    if (result.chunksEmbedded === 0) break;
  }

  return { chunks: embedded, durationMs: duration, truncated, iterations };
}

/**
 * Run `fn` with `console.warn` patched to drop qmd's per-chunk truncation
 * warnings (`⚠ … truncated to fit embedding context …`). Returns the count
 * so the caller can fold it into a one-line summary. All other warns pass
 * through unchanged. Always restores `console.warn` in a `finally`.
 *
 * The patterns are matched as plain strings against the first argument —
 * qmd emits these via `console.warn(\`⚠ Text truncated to fit embedding
 * context (\${N} tokens)\`)` and the same with a `Batch ` prefix.
 */
async function withTruncationFilter<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; truncatedCount: number }> {
  const original = console.warn;
  let truncatedCount = 0;
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === "string" && first.includes("truncated to fit embedding context")) {
      truncatedCount++;
      return;
    }
    original(...args);
  };
  try {
    const result = await fn();
    return { result, truncatedCount };
  } finally {
    console.warn = original;
  }
}
