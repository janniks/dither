import { consola } from "consola";
import { homedir } from "node:os";
import { clearScreenDown, moveCursor } from "node:readline";
import pc from "picocolors";
import { sanitizePluginText, wrapPluginText } from "./untrusted-text";

const HOME = homedir();

/**
 * Substitute `~` for the current user's home in display output.
 *   /Users/jannik/.dither/foo → ~/.dither/foo
 *   /Users/jannik             → ~
 *   /Users/other/foo          → /Users/other/foo (unchanged)
 *
 * Display-only — never write the abbreviated form back into config or grants.
 */
export function tildePath(p: string): string {
  if (p === HOME) return "~";
  if (p.startsWith(`${HOME}/`)) return `~${p.slice(HOME.length)}`;
  return p;
}

/**
 * Inverse of `tildePath`. Used when reading user-typed paths from prompts
 * (or manifest defaults) before passing them to `resolve()` — `path.resolve`
 * doesn't expand `~`, so `~/foo` would resolve relative to cwd instead.
 *
 * Only the leading `~` (alone or followed by `/`) is treated specially.
 * `~user/foo` is left alone — we don't resolve other users' homes.
 */
export function untildePath(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return `${HOME}/${p.slice(2)}`;
  return p;
}

/**
 * Single import point for interactive TUI in the CLI. Wraps consola (prompts)
 * and provides progress helpers so a future swap (to `@clack/prompts`,
 * `@inquirer/prompts`, etc.) is a one-file change.
 *
 * Patterns (see AGENTS.md → CLI / TUI):
 *   - `promptText` shows a question, pre-fills a default Enter accepts, and
 *     re-prompts on validation failure. Hints belong inline in the message
 *     in parens — keep prompts to one line.
 *   - `confirm` overwrites consola's prompt echo with a tidy
 *     `✓ Label: value` line so the answer reads as "locked in".
 *   - `stepStart` / `stepDone` bracket slow work with `→` / `✓` lines so the
 *     user never wonders whether the CLI is hung.
 *   - `printTable` lays out rows of cells with dynamic widths, alignment,
 *     color callbacks, and a TTY/TSV split. Lives in `./table` and is
 *     re-exported below so commands can import everything from `./prompt`.
 *
 * Ctrl-C propagates from consola as a rejection; the caller decides whether
 * to translate to a clean exit.
 */

export interface PromptTextOptions {
  message: string;
  /** Value used when the user presses Enter without typing. Not shown
   *  in the input field — bake it into `message` (e.g. in parens) if you
   *  want it visible. */
  default?: string;
  /** Dim ghost text shown in the empty input field. Disappears as soon
   *  as the user types. NOT used as the value on Enter — that's `default`. */
  placeholder?: string;
  /** Returns null on success or an error string to display + re-prompt. */
  validate?: (value: string) => string | null | Promise<string | null>;
}

export interface PromptSelectOption<T extends string = string> {
  label: string;
  value: T;
  hint?: string;
}

export interface PromptSelectOptions<T extends string = string> {
  message: string;
  options: PromptSelectOption<T>[];
  /** Value to pre-highlight. Defaults to the first option. */
  initial?: T;
}

export async function promptSelect<T extends string = string>(
  opts: PromptSelectOptions<T>,
): Promise<T> {
  const raw = (await consola.prompt(opts.message, {
    type: "select",
    options: opts.options,
    initial: opts.initial ?? opts.options[0]?.value,
    cancel: "reject",
  })) as unknown;
  // consola returns the option object in some versions, the bare value in
  // others — normalise both shapes.
  if (typeof raw === "string") return raw as T;
  if (raw && typeof raw === "object" && "value" in raw) {
    return (raw as { value: T }).value;
  }
  throw new Error("promptSelect: unexpected consola response shape");
}

export interface PromptMultiSelectOptions<T extends string = string> {
  message: string;
  options: PromptSelectOption<T>[];
  /** Values pre-checked when the prompt opens. */
  initial?: T[];
}

/**
 * Multi-select checklist. Pre-checked entries come from `initial`. Returns
 * the user's final selection. For arbitrary user-supplied entries (e.g.
 * a host not in the manifest), call this together with `promptText` in a
 * follow-up loop — consola's multiselect doesn't natively support an
 * inline "+ Add custom…" row.
 */
export async function promptMultiSelect<T extends string = string>(
  opts: PromptMultiSelectOptions<T>,
): Promise<T[]> {
  const initialSet = new Set(opts.initial ?? []);
  const raw = (await consola.prompt(opts.message, {
    type: "multiselect",
    options: opts.options.map((o) => ({ ...o, selected: initialSet.has(o.value) })),
    cancel: "reject",
  })) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("promptMultiSelect: unexpected consola response shape");
  }
  return raw.map((item) =>
    typeof item === "string" ? (item as T) : (item as { value: T }).value,
  );
}

/**
 * Yes/no confirmation. Enter accepts `defaultValue`. Returns the user's
 * choice as a boolean. Ctrl-C rejects (caller handles cancel).
 */
export async function promptConfirm(message: string, defaultValue = true): Promise<boolean> {
  const raw = (await consola.prompt(message, {
    type: "confirm",
    initial: defaultValue,
    cancel: "reject",
  })) as unknown;
  return Boolean(raw);
}

/**
 * Compose the prompt line for `promptText`. When `default` is provided and
 * the caller hasn't already baked an "ENTER" hint into `message`, append
 * `(ENTER for <default>)` so the user sees what Enter accepts. Pure — exposed
 * for tests.
 */
export function composePromptMessage(message: string, dflt: string | undefined): string {
  const i = message.search(/\s*\(ENTER/i);
  if (i !== -1) return pc.cyan(message.slice(0, i)) + message.slice(i);
  if (!dflt) return message;
  return `${pc.cyan(message)} (ENTER for ${tildePath(dflt)})`;
}

export async function promptText(opts: PromptTextOptions): Promise<string> {
  const msg = composePromptMessage(opts.message, opts.default);
  for (;;) {
    const raw = (await consola.prompt(msg, {
      type: "text",
      placeholder: opts.placeholder,
      default: opts.default,
      cancel: "reject",
    })) as unknown;
    const value = typeof raw === "string" && raw !== "" ? raw : opts.default ?? "";
    if (opts.validate) {
      const err = await opts.validate(value);
      if (err) {
        consola.warn(err);
        continue;
      }
    }
    return value;
  }
}

/**
 * Truncate a value so the recap line fits on one terminal row even when
 * the original answer is something long like a cookie or token. Shows the
 * head + an ellipsis; the full value is still visible in consola's prompt
 * echo above. Non-TTY callers (tests, pipes) keep the full value — wrap
 * doesn't matter there and tests assert on full content.
 */
function clip(value: string, room: number): string {
  if (!process.stdout.isTTY) return value;
  if (value.length <= room) return value;
  return `${value.slice(0, Math.max(8, room - 1))}…`;
}

/**
 * Middle-truncate a line so it fits on one terminal row. Used by
 * carriage-return rewrites (progress lines) where wrapping would leave
 * garbage: `\r\x1b[K` only clears one visual line, so the overflow stays.
 *
 * Keeps the head + tail intact (most context-rich), drops the middle.
 * Returns the input unchanged for non-TTY callers.
 *
 *   fitOneLine("forward: mpdm-foo--bar--baz--qux (mpim) — budget 200", 40)
 *   → "forward: mpdm-foo--ba…(mpim) — budget 200"
 */
export function fitOneLine(value: string, cols: number): string {
  if (value.length <= cols) return value;
  if (cols < 4) return value.slice(0, cols);
  const half = Math.floor((cols - 1) / 2);
  const head = value.slice(0, half);
  const tail = value.slice(value.length - (cols - half - 1));
  return `${head}…${tail}`;
}

/**
 * After `promptText` resolves, overwrite consola's echoed line with a
 * compact `✓ label: value` confirmation. consola's submit handler renders
 * a final frame (the prompt + the typed answer) and `close()` then writes
 * a trailing `\n`, so the cursor ends two lines below the prompt line —
 * `moveCursor(-2)` lands us back on it and `clearScreenDown` wipes both.
 *
 * Wrapping caveat: when the typed value spans multiple terminal lines we
 * can't reliably wipe past it (we'd shred earlier output), so we skip the
 * wipe in that case and just append the `✓` line under consola's echo.
 *
 * Convention: pass `label` lowercase (`"library"`, not `"Library"`) — the
 * rest of init's inline output is sentence-case, and Title-Cased inline
 * labels stand out. Reserve capitals for sentence beginnings.
 *
 * On non-TTY (tests, pipes) the cursor moves are no-ops and we just append.
 */
export function confirm(label: string, value: string): void {
  const cols = process.stdout.columns ?? 80;
  const room = Math.max(20, cols - label.length - 5);
  const shown = clip(value, room);
  if (process.stdout.isTTY) {
    const lineFits = value.length + label.length + 4 <= cols;
    if (lineFits) {
      // Cursor advance accounting (empirically derived):
      //   - No-box case: consola/clack consumes 2 rows for prompt + submit.
      //   - With-box case: pluginText writes (out.length - 1) row advances
      //     (no trailing \n — see pluginText), then consola/clack consumes
      //     3 rows (its prompt seems to render an extra anchor row when the
      //     cursor enters mid-line). Net = out.length + 2.
      const extra = pluginTextLinesAbove;
      const k = extra > 0 ? extra + 2 : 2;
      moveCursor(process.stdout, 0, -k);
      clearScreenDown(process.stdout);
    }
  }
  pluginTextLinesAbove = 0;
  process.stdout.write(`${pc.green("✓")} ${label}: ${shown}\n`);
}

// Tracks the line count of the most recent `pluginText` render so the next
// `confirm` can wipe it (along with the echoed prompt). Reset on every
// confirm() call and on every pluginText() call that renders nothing.
let pluginTextLinesAbove = 0;

/**
 * Render manifest-supplied prose (a plugin's `description`, env / file
 * `description`) inside a labelled `from plugin` box. The chrome is
 * Dither's voice (dim); the contents are the plugin's voice, sanitized
 * through `sanitizePluginText` so ANSI escapes, OSC 8 hyperlinks, and
 * stray control characters can't reach the user's terminal raw.
 *
 * Every render of plugin-supplied text in the CLI must flow through
 * this single entry point. Audit rule: nothing else in packages/cli/
 * may read `manifest.*.description` and write it directly to stdout
 * (see specs/plugin-prompt-untrusted-text.md).
 *
 * Empty / whitespace-only descriptions render nothing.
 */
export function pluginText(raw: string): void {
  const safe = sanitizePluginText(raw);
  if (safe.text === "") {
    pluginTextLinesAbove = 0;
    return;
  }
  const cols = Math.max(40, Math.min(100, process.stdout.columns ?? 80));
  const inner = cols - 4;
  const lines = wrapPluginText(safe.text, inner);
  if (safe.truncated) lines.push("", "(description truncated)");
  const label = " from plugin ";
  const topFill = "─".repeat(Math.max(0, cols - 3 - label.length));
  const bot = "─".repeat(cols - 2);
  const out: string[] = [""]; // leading blank visually anchors the box to the prompt below, not the answer above
  out.push(pc.dim(`┌─${label}${topFill}┐`));
  for (const line of lines) {
    const pad = " ".repeat(Math.max(0, inner - line.length));
    out.push(`${pc.dim("│")} ${line}${pad} ${pc.dim("│")}`);
  }
  out.push(pc.dim(`└${bot}┘`));
  // No trailing newline: consola prepends its own \n before the prompt, so
  // doubling up would leave a visible blank line between the bottom border
  // and the prompt arrow.
  process.stdout.write(out.join("\n"));
  pluginTextLinesAbove = out.length;
}

/**
 * Render advisory prose in Dither's own voice — visually distinct from
 * `pluginText` (different border color + `note` label) so the user can
 * tell who's talking. Used for install-time messages that aren't a
 * single-line `→`/`✓` step (e.g. the macOS Full Disk Access handoff).
 *
 * Newlines in `message` split into lines; each is wrapped to the box's
 * inner width.
 */
export function ditherText(message: string): void {
  const trimmed = message.trim();
  if (trimmed === "") return;
  const cols = Math.max(40, Math.min(100, process.stdout.columns ?? 80));
  const inner = cols - 4;
  const lines: string[] = [];
  for (const para of trimmed.split("\n")) {
    if (para === "") {
      lines.push("");
      continue;
    }
    let rest = para;
    while (rest.length > inner) {
      let cut = rest.lastIndexOf(" ", inner);
      if (cut <= 0) cut = inner;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    lines.push(rest);
  }
  const label = " note ";
  // Top line is `┌` + `─` + label + topFill + `┐` = 3 + label.length + topFill.
  const topFill = "─".repeat(Math.max(0, cols - 3 - label.length));
  const bot = "─".repeat(cols - 2);
  const out: string[] = [];
  out.push(pc.yellow(`┌─${label}${topFill}┐`));
  for (const line of lines) {
    const pad = " ".repeat(Math.max(0, inner - line.length));
    out.push(`${pc.yellow("│")} ${line}${pad} ${pc.yellow("│")}`);
  }
  out.push(pc.yellow(`└${bot}┘`));
  process.stdout.write(`${out.join("\n")}\n`);
}

/**
 * Bracket a slow step. Print `→ message...` before the work starts so the
 * user always knows what the CLI is doing; pair with `stepDone` (or
 * `stepFail`) once it returns. Both lines remain in scrollback as a log.
 */
export function stepStart(message: string): void {
  process.stdout.write(`${pc.dim("→")} ${message}\n`);
}

export function stepDone(message: string): void {
  process.stdout.write(`${pc.green("✓")} ${message}\n`);
}

export function stepFail(message: string): void {
  process.stdout.write(`${pc.yellow("⚠")} ${message}\n`);
}

// Tabular output. Lives in its own deep-module file (`./table`) so it
// can be imported and tested in isolation; re-exported here so command
// files keep a single TUI import surface.
export { printTable, type ColOpt } from "./table";
