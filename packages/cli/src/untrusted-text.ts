/**
 * Sanitization + wrapping for manifest-supplied prose.
 *
 * Plugin manifests are untrusted: ANSI escapes, OSC 8 hyperlinks, raw
 * carriage returns, and stray control characters all need to be
 * neutralized before the text reaches the user's terminal. Anything
 * the CLI shows from a manifest must flow through these two
 * functions, then through `pluginText` in `prompt.ts`.
 *
 * Both functions are pure: text in, text out. No TTY plumbing.
 */

const MAX = 500;

// ESC followed by:
//   - CSI: `[` params (0x30-0x3F) intermediates (0x20-0x2F) final (0x40-0x7E)
//   - OSC: `]` body (no BEL/ESC) terminated by BEL or ST (`ESC \`)
//   - any single Fe byte (0x40-0x5F) — covers stray ST, NEL, etc.
const ESC = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;

// Control chars 0x00-0x1F except LF (0x0A), plus DEL (0x7F).
const CTRL = /[\x00-\x09\x0b-\x1f\x7f]/g;

export interface Sanitized {
  text: string;
  truncated: boolean;
}

export function sanitizePluginText(raw: string): Sanitized {
  const stripped = raw.replace(ESC, "");
  const normalized = stripped.replace(/\r\n?/g, "\n").replace(CTRL, "?");
  const collapsed = normalized.replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length <= MAX) return { text: collapsed, truncated: false };
  return { text: `${collapsed.slice(0, MAX - 1).trimEnd()}…`, truncated: true };
}

/**
 * Word-wrap to `width` columns. Existing newlines are hard breaks.
 * Words longer than `width` force-break mid-word. Returns one entry
 * per output line; empty strings for blank lines.
 */
export function wrapPluginText(safe: string, width: number): string[] {
  if (width < 1) return [safe];
  return safe.split("\n").flatMap((line) => wrapLine(line, width));
}

function wrapLine(line: string, width: number): string[] {
  if (line === "") return [""];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(/\s+/).filter((w) => w !== "")) {
    if (word.length > width) {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < word.length; i += width) {
        const chunk = word.slice(i, i + width);
        if (chunk.length === width) out.push(chunk);
        else cur = chunk;
      }
      continue;
    }
    const next = cur === "" ? word : `${cur} ${word}`;
    if (next.length > width) {
      out.push(cur);
      cur = word;
      continue;
    }
    cur = next;
  }
  if (cur !== "") out.push(cur);
  return out;
}
