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

import { readFile, writeFile, mkdir } from "node:fs/promises";
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
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as PluginInput<C, S>;
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

export async function readState<T = Record<string, unknown>>(): Promise<T | null> {
  const path = env("DITHER_STATE_FILE");
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf-8");
  if (content.trim() === "") return null;
  return JSON.parse(content) as T;
}

export async function writeState<T>(state: T): Promise<void> {
  const path = env("DITHER_STATE_FILE");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}
