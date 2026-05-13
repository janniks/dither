/**
 * Compact relative-time formatter for "next fire" / "due in" displays.
 *
 *   30s ahead   → "in 30s"
 *   2h 15m      → "in 2h 15m"
 *   3 days      → "in 3d 4h"
 *   in the past → "now" (no negative duration shown — caller decides)
 *
 * Two units max — granularity falls off with distance, matching the spec
 * a human reading a CLI table actually wants. Pure function; tests are
 * table-driven.
 */
export function formatRelTime(targetMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, targetMs - nowMs);
  if (diff < 1_000) return "now";

  const s = Math.floor(diff / 1_000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (d > 0) {
    const remH = h - d * 24;
    return remH > 0 ? `in ${d}d ${remH}h` : `in ${d}d`;
  }
  if (h > 0) {
    const remM = m - h * 60;
    return remM > 0 ? `in ${h}h ${remM}m` : `in ${h}h`;
  }
  if (m > 0) {
    const remS = s - m * 60;
    return remS > 0 ? `in ${m}m ${remS}s` : `in ${m}m`;
  }
  return `in ${s}s`;
}
