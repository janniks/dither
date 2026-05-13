import { consola } from "consola";
import { clearScreenDown, moveCursor } from "node:readline";
import pc from "picocolors";

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
 * compact `✓ Label: value` confirmation. On non-TTY (tests, pipes) the
 * cursor moves are no-ops and we just append the line.
 */
export function confirm(label: string, value: string): void {
  if (process.stdout.isTTY) {
    moveCursor(process.stdout, 0, -1);
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
