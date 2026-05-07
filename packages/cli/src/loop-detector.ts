/**
 * Loop detection (not prevention). Tracks the depth of a *trigger chain* —
 * fire A causes fire B causes fire C. When depth ≥ threshold (default 3) for
 * a given chain root, the daemon halts the next fire and surfaces it.
 *
 * "Chain root" is the originating trigger source: the schedule entry, the
 * watched-path file, etc. We key on `triggerSource` so two unrelated chains
 * each starting at depth 1 don't collude.
 *
 * TTL: chain entries age out after 30s of quiet. A trigger arriving after
 * the TTL counts as a fresh root, not a continuation.
 */

const DEFAULT_THRESHOLD = 3;
const DEFAULT_TTL_MS = 30_000;

interface ChainState {
  depth: number;
  lastTouched: number;
  halts: number;
}

export interface HaltRecord {
  triggerSource: string;
  pluginName: string;
  depth: number;
  at: string;
}

export class LoopDetector {
  private readonly threshold: number;
  private readonly ttlMs: number;
  private readonly chains = new Map<string, ChainState>();
  readonly recentHalts: HaltRecord[] = [];

  constructor({ threshold = DEFAULT_THRESHOLD, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.threshold = threshold;
    this.ttlMs = ttlMs;
  }

  /**
   * Returns true if the upcoming fire should be halted (depth would cross the
   * threshold). Either way the depth is incremented and the chain timestamp
   * is refreshed; consumers should still call `record(true)` if they fired or
   * `record(false)` if they bailed.
   */
  shouldHalt(triggerSource: string, _pluginName: string): boolean {
    this.gc();
    const state = this.chains.get(triggerSource);
    const nextDepth = (state?.depth ?? 0) + 1;
    return nextDepth > this.threshold;
  }

  record(triggerSource: string, pluginName: string, fired: boolean): void {
    this.gc();
    const now = Date.now();
    const state = this.chains.get(triggerSource) ?? { depth: 0, lastTouched: now, halts: 0 };
    if (fired) {
      state.depth += 1;
    } else {
      state.halts += 1;
      this.recentHalts.unshift({
        triggerSource,
        pluginName,
        depth: state.depth + 1,
        at: new Date(now).toISOString(),
      });
      if (this.recentHalts.length > 16) this.recentHalts.length = 16;
    }
    state.lastTouched = now;
    this.chains.set(triggerSource, state);
  }

  /**
   * Reset the chain rooted at this source — call when a fire's effects have
   * settled (post-promote, after self-trigger suppression window). In v0 the
   * caller can simply rely on the TTL.
   */
  reset(triggerSource: string): void {
    this.chains.delete(triggerSource);
  }

  private gc(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.chains) {
      if (v.lastTouched < cutoff) this.chains.delete(k);
    }
  }

  size(): number {
    this.gc();
    return this.chains.size;
  }
}
