import { consola } from "consola";
import { homedir } from "node:os";
import { clearScreenDown, moveCursor } from "node:readline";
import pc from "picocolors";

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

export async function promptText(opts: PromptTextOptions): Promise<string> {
  for (;;) {
    const raw = (await consola.prompt(opts.message, {
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
 * After `promptText` resolves, overwrite consola's echoed line with a
 * compact `✓ label: value` confirmation. consola's submit handler renders
 * a final frame (the prompt + the typed answer) and `close()` then writes
 * a trailing `\n`, so the cursor ends two lines below the prompt line —
 * `moveCursor(-2)` lands us back on it and `clearScreenDown` wipes both.
 * Without this we'd leave a stray `✔ Where should…` echo above our `✓`.
 *
 * Convention: pass `label` lowercase (`"library"`, not `"Library"`) — the
 * rest of init's inline output is sentence-case, and Title-Cased inline
 * labels stand out. Reserve capitals for sentence beginnings.
 *
 * On non-TTY (tests, pipes) the cursor moves are no-ops and we just append.
 */
export function confirm(label: string, value: string): void {
  if (process.stdout.isTTY) {
    moveCursor(process.stdout, 0, -2);
    clearScreenDown(process.stdout);
  }
  process.stdout.write(`${pc.green("✓")} ${label}: ${value}\n`);
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
