import { consola } from "consola";

/**
 * Single import point for interactive prompts in the CLI. Wraps consola so
 * a future swap (to `@clack/prompts`, `@inquirer/prompts`, etc.) is a
 * one-file change. Helpers grow as new prompt sites appear.
 *
 * Each prompt:
 *   - shows a short question,
 *   - exposes a one-line hint when supplied,
 *   - pre-fills a default that Enter accepts,
 *   - validates after submission and re-prompts on failure.
 *
 * Ctrl-C propagates from consola as a rejection; the caller decides whether
 * to translate to a clean exit.
 */

export interface PromptTextOptions {
  message: string;
  /** Value used when the user presses Enter without typing. Not shown
   *  in the input field — surface it via `hint` if you want it visible. */
  default?: string;
  /** Dim ghost text shown in the empty input field. Disappears as soon
   *  as the user types. NOT used as the value on Enter — that's `default`. */
  placeholder?: string;
  /** Free-form hint shown under the question. */
  hint?: string;
  /** Returns null on success or an error string to display + re-prompt. */
  validate?: (value: string) => string | null | Promise<string | null>;
}

export async function promptText(opts: PromptTextOptions): Promise<string> {
  for (;;) {
    const formattedMessage = opts.hint
      ? `${opts.message}\n  ${opts.hint}`
      : opts.message;
    const raw = (await consola.prompt(formattedMessage, {
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
