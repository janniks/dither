import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveHome } from "./home";

export const CONFIG_SCHEMA_VERSION = 1;

export interface DitherConfig {
  schema: { version: number };
  library: { path: string };
}

export class NotInitializedError extends Error {
  constructor() {
    super("dither is not initialized. Run `dither init` to set up your library.");
    this.name = "NotInitializedError";
  }
}

export function configPath(): string {
  return join(resolveHome(), "config.json");
}

/**
 * Strip `//` line comments and `/* *\/` block comments while preserving the
 * contents of string literals. Lets a hand-edited `config.json` carry comments
 * without us pulling in a JSONC dependency.
 */
function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;
  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch as '"' | "'";
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export async function loadConfig(): Promise<DitherConfig | null> {
  const path = configPath();
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new Error(
      `config at ${path} is malformed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return validate(parsed, path);
}

function validate(parsed: unknown, path: string): DitherConfig {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`config at ${path} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const schema = obj.schema as Record<string, unknown> | undefined;
  if (!schema || typeof schema !== "object" || typeof schema.version !== "number") {
    throw new Error(`config at ${path} is missing schema.version`);
  }
  if (schema.version !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `config at ${path} has schema.version=${schema.version}, expected ${CONFIG_SCHEMA_VERSION}`,
    );
  }
  const library = obj.library as Record<string, unknown> | undefined;
  if (!library || typeof library !== "object" || typeof library.path !== "string") {
    throw new Error(`config at ${path} is missing library.path`);
  }
  return {
    schema: { version: schema.version },
    library: { path: library.path },
  };
}

export async function saveConfig(cfg: DitherConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
}

export async function assertInitialized(): Promise<DitherConfig> {
  const cfg = await loadConfig();
  if (!cfg) throw new NotInitializedError();
  return cfg;
}
