import pc from "picocolors";
import { tildePath } from "./display";

/**
 * Render qmd's model-weight download as one clean two-line summary instead
 * of the four-plus lines + animated bar that `node-llama-cpp` writes via
 * `ipull` and `stdout-update`. We can't suppress the noise at qmd's source
 * (`cli: true` is hard-wired), so we capture every byte written to stdout
 * during the download window, track the virtual cursor Y so we know how
 * many lines to clear when it's done, and replace the captured block with
 * a synthesized `✓ downloaded model weights (333MB in 2m)` line plus a
 * dim, indented path line. If the parse misses (qmd reworded), we fall
 * back to a generic line — never crash.
 *
 * Why we don't just indent the bar instead: `stdout-update` reads
 * `process.stdout.columns` directly and redraws by line count. Prefixing
 * each line would push width past `columns`, the terminal soft-wraps, and
 * the eraser leaves orphan rows on the next frame. Capture-and-replace
 * sidesteps that entirely.
 */

export interface DownloadSummary {
  /** e.g. "333.59MB" or "1.2GB" — preserved as printed. */
  size: string;
  /** e.g. "2m" or "2m 14s" or "45s" — preserved as printed. */
  duration: string;
  /** Path of the downloaded gguf, tildified. */
  path: string;
}

/**
 * Pure: extract size + duration + path from a captured qmd download
 * buffer. Returns `null` if either required line is missing or
 * unparseable — caller falls back to a generic line in that case.
 *
 * Targets two lines qmd's downloader writes:
 *   ✔ <name>.gguf downloaded 333.59MB in 2m
 *   Downloaded to <path>
 */
export function parseDownloadSummary(buffer: string): DownloadSummary | null {
  // Strip ANSI escape sequences before matching — qmd colorizes its output.
  const plain = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const sizeMatch = plain.match(
    /\bdownloaded\s+([\d.]+\s*(?:MB|GB|KB|TB))\s+in\s+([^\n]+?)(?:\r|\n|$)/i,
  );
  const pathMatch = plain.match(/\bDownloaded to\s+(.+?)(?:\r|\n|$)/);
  if (!sizeMatch || !pathMatch) return null;
  return {
    size: sizeMatch[1]!.replace(/\s+/g, ""),
    duration: sizeMatch[2]!.trim(),
    path: tildePath(pathMatch[1]!.trim()),
  };
}

/**
 * Track a virtual cursor Y position from stdout content. Each `\n`
 * advances Y by 1; CSI cursor-up / down sequences move Y by their count.
 * Stops at 0 (cursor can't go above the capture start).
 *
 * Exported for unit testing — the same logic drives `QmdDownloadCapture`'s
 * internal counter.
 */
export function virtualYDelta(text: string): number {
  let dy = 0;
  // Matches: bare \n, OR CSI <N>? <ABEF>. We deliberately ignore other CSI
  // sequences (color, erase-line, cursor-column) — they don't affect Y.
  const re = /\n|\x1b\[(\d+)?([ABEF])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "\n") {
      dy += 1;
    } else {
      const n = m[1] ? Number.parseInt(m[1], 10) : 1;
      if (m[2] === "A" || m[2] === "F") dy -= n;
      else if (m[2] === "B" || m[2] === "E") dy += n;
    }
  }
  return dy;
}

/**
 * Capture stdout during qmd's model-weight download phase, then replace
 * the captured block with a clean summary. Use as:
 *
 *   const capture = new QmdDownloadCapture();
 *   capture.start();           // hooks stdout.write
 *   // ... call qmd embed/whatever triggers download
 *   capture.finish();          // erases captured block, prints summary
 *
 * On non-TTY (`!process.stdout.isTTY`) start() / finish() are no-ops —
 * we can't erase scrollback without escape codes anyway, and CI logs are
 * better off keeping qmd's full output.
 */
export class QmdDownloadCapture {
  private origWrite: typeof process.stdout.write | null = null;
  private buffer = "";
  private virtualY = 0;
  private finished = false;

  /**
   * Install the stdout hook. Idempotent — repeated starts are no-ops.
   * No-op on non-TTY.
   */
  start(): void {
    if (this.origWrite !== null || !process.stdout.isTTY) return;
    const orig = process.stdout.write.bind(process.stdout);
    this.origWrite = orig;
    const write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      this.buffer += text;
      this.virtualY = Math.max(0, this.virtualY + virtualYDelta(text));
      // Pass through so the user sees the live bar.
      return (orig as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(
        chunk,
        ...rest,
      );
    };
    process.stdout.write = write as typeof process.stdout.write;
  }

  /**
   * Restore stdout, erase the captured block, and print the summary.
   * Returns the parsed summary (or null if parse failed / nothing was
   * captured — model was already cached).
   */
  finish(): DownloadSummary | null {
    if (this.finished) return null;
    this.finished = true;
    const orig = this.origWrite;
    if (!orig) return null;
    process.stdout.write = orig;

    if (this.buffer.length === 0) return null; // model was cached — nothing to erase

    const summary = parseDownloadSummary(this.buffer);
    if (this.virtualY > 0) {
      orig(`\x1b[${this.virtualY}A\x1b[J`);
    }
    if (summary) {
      orig(`${pc.green("✓")} downloaded model weights (${summary.size} in ${summary.duration})\n`);
      orig(`  ${pc.dim(summary.path)}\n`);
    } else {
      orig(`${pc.green("✓")} downloaded model weights\n`);
    }
    return summary;
  }
}
