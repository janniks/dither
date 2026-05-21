import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { resolveHome } from "./home";

const CONFIG_SCHEMA_VERSION = 2;

export interface ExternalCollection {
  name: string;
  path: string;
}

export interface DitherConfig {
  schema: { version: number };
  library: { path: string };
  collections: { external: ExternalCollection[] };
}

export class NotInitializedError extends Error {
  constructor() {
    super("dither is not initialized. Run `dither init` to set up your library.");
    this.name = "NotInitializedError";
  }
}

function configPath(): string {
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
  // v1 (pre-external-collections) is accepted transparently and loaded as
  // v2 with an empty external registry. Saves always emit v2; v1 files
  // are not rewritten in place until the next saveConfig.
  if (schema.version !== 1 && schema.version !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `config at ${path} has schema.version=${schema.version}, expected 1 or ${CONFIG_SCHEMA_VERSION}`,
    );
  }
  const library = obj.library as Record<string, unknown> | undefined;
  if (!library || typeof library !== "object" || typeof library.path !== "string") {
    throw new Error(`config at ${path} is missing library.path`);
  }
  const collectionsRaw = obj.collections;
  if (
    schema.version === CONFIG_SCHEMA_VERSION &&
    collectionsRaw !== undefined &&
    (collectionsRaw === null || typeof collectionsRaw !== "object" || Array.isArray(collectionsRaw))
  ) {
    throw new Error(`config at ${path} has malformed collections (must be an object)`);
  }
  const collections = collectionsRaw as Record<string, unknown> | undefined;
  const externalRaw = collections?.external;
  const external: ExternalCollection[] = [];
  if (externalRaw !== undefined) {
    if (!Array.isArray(externalRaw)) {
      throw new Error(`config at ${path} has non-array collections.external`);
    }
    for (const entry of externalRaw) {
      if (!entry || typeof entry !== "object") {
        throw new Error(`config at ${path} has malformed collections.external entry`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== "string" || typeof e.path !== "string") {
        throw new Error(`config at ${path} has malformed collections.external entry`);
      }
      external.push({ name: e.name, path: e.path });
    }
  }
  return {
    schema: { version: CONFIG_SCHEMA_VERSION },
    library: { path: library.path },
    collections: { external },
  };
}

export async function saveConfig(cfg: DitherConfig): Promise<void> {
  const path = configPath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

export async function assertInitialized(): Promise<DitherConfig> {
  const cfg = await loadConfig();
  if (!cfg) throw new NotInitializedError();
  return cfg;
}

/**
 * Library root resolved against the loaded config. Dither-home paths
 * (pid, locks, plugins, daemon log, qmd index db) live in `home.ts` —
 * they're independent of the library configuration and don't go
 * through here.
 */
export async function libraryRoot(): Promise<string> {
  return (await assertInitialized()).library.path;
}
