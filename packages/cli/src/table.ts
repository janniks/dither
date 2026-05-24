/**
 * Tabular output for the CLI. Single entry point: `printTable`.
 *
 * Deep-module shape: small interface (rows + optional per-column hints),
 * broad capability inside (dynamic width per column, alignment, optional
 * color via callback, terminal-width-aware last-column truncation, and a
 * TTY/TSV split so the same call site emits human output on a terminal
 * and tab-separated values when piped).
 *
 * No imports from `prompt.ts` — kept dep-free so it can be used wherever
 * (and unit-tested in isolation). `prompt.ts` re-exports it so commands
 * keep a single TUI import surface.
 */

export interface ColOpt {
  align?: "left" | "right";
  /** Minimum column width in characters. */
  min?: number;
  /** Maximum column width. Cells longer than this are middle-truncated. */
  max?: number;
  /** Applied to the padded cell. Receives the padded string, returns the
   *  visible string (typically wrapped in ANSI escapes). */
  color?: (s: string) => string;
}

const GAP = "  ";

function fit(s: string, w: number): string {
  if (s.length <= w) return s;
  if (w < 4) return s.slice(0, w);
  const half = Math.floor((w - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - (w - half - 1))}`;
}

export function printTable(rows: string[][], cols: ColOpt[] = []): void {
  if (rows.length === 0) return;

  // Pipe-safe path: stable TSV, no color, no padding, no truncation.
  // Downstream tools (`grep`, `awk`, `cut`) parse cleanly.
  if (!process.stdout.isTTY) {
    for (const row of rows) console.log(row.join("\t"));
    return;
  }

  const ncols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: ncols }, (_, i) => {
    const cfg = cols[i] ?? {};
    const wide = rows.reduce((m, r) => Math.max(m, (r[i] ?? "").length), 0);
    const w = Math.max(wide, cfg.min ?? 0);
    return cfg.max === undefined ? w : Math.min(w, cfg.max);
  });

  // If the row would exceed terminal width, clamp the last column.
  const term = process.stdout.columns ?? 80;
  const last = widths.length - 1;
  const fixed = widths.slice(0, last).reduce((a, b) => a + b + GAP.length, 0);
  const lastW = widths[last] ?? 0;
  const overflow = fixed + lastW - term;
  if (overflow > 0) widths[last] = Math.max(0, lastW - overflow);

  for (const row of rows) {
    const cells = widths.map((w, i) => {
      const cfg = cols[i] ?? {};
      const fitted = fit(row[i] ?? "", w);
      // Skip trailing whitespace on the last left-aligned column.
      const padded = cfg.align === "right"
        ? fitted.padStart(w)
        : i === last
          ? fitted
          : fitted.padEnd(w);
      return cfg.color ? cfg.color(padded) : padded;
    });
    console.log(cells.join(GAP));
  }
}
