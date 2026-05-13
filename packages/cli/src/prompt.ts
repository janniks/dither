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
