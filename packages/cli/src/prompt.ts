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
  /** Pre-filled default. Enter at the empty prompt accepts this. */
  default?: string;
  /** Free-form hint shown alongside the prompt. Distinct from `default`. */
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
      placeholder: opts.default,
      default: opts.default,
      cancel: "reject",
    })) as unknown;
    const value = typeof raw === "string" ? raw : opts.default ?? "";
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
