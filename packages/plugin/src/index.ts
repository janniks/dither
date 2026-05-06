/**
 * `@dither/plugin` — author SDK.
 *
 * Plugins running under the dither plugin host get five env vars set:
 *   DITHER_RUN_DIR     — scratch dir for this run; write entry .md files here
 *   DITHER_INPUT_FILE  — path to a JSON file with config, secrets, files, targets
 *   DITHER_STATE_FILE  — path to the plugin's persistent state.json
 *   DITHER_TRIGGER     — "scheduled" | "watch" | "manual"
 *   DITHER_PLUGIN_NAME — the plugin's name; auto-stamped onto entry frontmatter
 *
 * Plugins write markdown entries to DITHER_RUN_DIR; the host validates and
 * promotes them into ~/.dither/entries/<collection>/ after the plugin exits.
 */

import { readFile as fsReadFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const VERSION = "0.0.1";

export interface PluginInput<C = Record<string, unknown>, S = Record<string, string>> {
  trigger: "scheduled" | "watch" | "manual";
  config: C;
  secrets: S;
  files: Record<string, string>;
  targets: string[];
}

export interface EntryOptions {
  /** Target collection (folder under entries/). Must be in this plugin's grant. */
  collection: string;
  /** Markdown body. Frontmatter is added by the SDK; do not include yourself. */
  body: string;
  /** Optional frontmatter fields. `source` is auto-stamped to the plugin name. */
  frontmatter?: Record<string, unknown>;
  /** Optional output filename (in DITHER_RUN_DIR). Defaults to `<id>.md`. */
  filename?: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set; this code must run inside the dither plugin host.`);
  }
  return v;
}

export async function readInput<C = Record<string, unknown>, S = Record<string, string>>(): Promise<
  PluginInput<C, S>
> {
  const path = env("DITHER_INPUT_FILE");
  const content = await fsReadFile(path, "utf-8");
  return JSON.parse(content) as PluginInput<C, S>;
}

/**
 * Read a file the user supplied as a `files[]` input. Resolves the input id
 * to its absolute path (which the host already added to Deno's --allow-read
 * allowlist) and returns the UTF-8 contents as a string.
 *
 * Saves plugin authors from importing `node:fs/promises` and the
 * lookup-then-read two-step:
 *
 *   // before
 *   import { readFile } from "node:fs/promises";
 *   import { readInput } from "@dither/plugin";
 *   const input = await readInput();
 *   const body = await readFile(input.files.SOURCE, "utf-8");
 *
 *   // after
 *   import { readFile } from "@dither/plugin";
 *   const body = await readFile("SOURCE");
 *
 * Throws if the input id was not declared in the manifest's `files[]` or was
 * not provided at install time. For non-utf-8 reads, fall back to
 * `node:fs/promises` directly.
 */
export async function readFile(inputId: string): Promise<string> {
  const inputPath = env("DITHER_INPUT_FILE");
  const inputContent = await fsReadFile(inputPath, "utf-8");
  const input = JSON.parse(inputContent) as PluginInput;
  const path = input.files[inputId];
  if (!path) {
    throw new Error(
      `File input '${inputId}' was not provided at install time (or is not declared in the manifest's files[]).`,
    );
  }
  return await fsReadFile(path, "utf-8");
}

function yamlValue(v: unknown): string {
  // Lean YAML serializer: emit JSON for everything. Most YAML parsers accept
  // JSON-style strings/numbers/bools/arrays inline. Keeps the SDK dep-free.
  return JSON.stringify(v);
}

export async function writeEntry(opts: EntryOptions): Promise<string> {
  const runDir = env("DITHER_RUN_DIR");
  const pluginName = env("DITHER_PLUGIN_NAME");

  const explicitId = typeof opts.frontmatter?.id === "string" ? opts.frontmatter.id : undefined;
  const id = explicitId ?? randomUUID();

  const baseName = opts.filename ?? `${id}.md`;
  const out = join(runDir, baseName);

  const frontmatter: Record<string, unknown> = {
    ...opts.frontmatter,
    id,
    source: pluginName,
    collection: opts.collection,
  };

  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${yamlValue(v)}`);
  const content = `---\n${fmLines.join("\n")}\n---\n\n${opts.body}\n`;

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, content, "utf-8");
  return out;
}

/**
 * Read the plugin's persistent state. The caller passes the initial value
 * the plugin should see on its first run (or after the state file is wiped) —
 * the SDK returns that value when no state has been written yet, so the
 * plugin never has to deal with a `null` branch.
 *
 * The type parameter is inferred from `initial`, so most call sites can
 * drop the explicit generic:
 *
 *   const state = await readState({ runs: 0 });
 *   state.runs += 1;
 *   await writeState(state);
 */
export async function readState<T>(initial: T): Promise<T> {
  const path = env("DITHER_STATE_FILE");
  if (!existsSync(path)) return initial;
  const content = await fsReadFile(path, "utf-8");
  if (content.trim() === "") return initial;
  return JSON.parse(content) as T;
}

export async function writeState<T>(state: T): Promise<void> {
  const path = env("DITHER_STATE_FILE");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}
