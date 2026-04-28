import { mkdir, cp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveHome } from "./home";
import { parsePackage, type Manifest, type ParsedPackage } from "./manifest";

export type InputValue = string | number | boolean;

export interface InstallOptions {
  source: string;
  /** Values for the manifest's declared `inputs[]`, keyed by `id`. */
  inputs?: Record<string, InputValue>;
  /** Paths for the manifest's declared `files[]`, keyed by `id`. */
  files?: Record<string, string>;
}

export interface InstalledPlugin {
  name: string;
  version: string;
  dest: string;
}

function coerceInput(kind: "secret" | "string" | "number" | "bool", value: InputValue): InputValue {
  if (kind === "number") {
    return typeof value === "number" ? value : Number(value);
  }
  if (kind === "bool") {
    if (typeof value === "boolean") return value;
    return value === "true" || value === "1" || value === 1;
  }
  return String(value);
}

function resolveInputs(
  declared: Manifest["inputs"],
  provided: Record<string, InputValue> | undefined,
): Record<string, InputValue> {
  const result: Record<string, InputValue> = {};
  for (const def of declared ?? []) {
    const userValue = provided?.[def.id];
    if (userValue !== undefined) {
      result[def.id] = coerceInput(def.kind, userValue);
      continue;
    }
    if (def.default !== undefined) {
      result[def.id] = def.default as InputValue;
      continue;
    }
    throw new Error(`Required input '${def.id}' was not provided and has no default.`);
  }
  return result;
}

async function resolveFiles(
  declared: Manifest["files"],
  provided: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const def of declared ?? []) {
    const userValue = provided?.[def.id];
    if (userValue === undefined) {
      if (def.required) {
        throw new Error(`Required file input '${def.id}' was not provided.`);
      }
      continue;
    }
    const absPath = resolve(userValue);
    if (!existsSync(absPath)) {
      throw new Error(`File input '${def.id}' path does not exist: ${absPath}`);
    }
    const stats = await stat(absPath);
    if (def.kind === "file" && !stats.isFile()) {
      throw new Error(`File input '${def.id}' must be a file, got: ${absPath}`);
    }
    if (def.kind === "folder" && !stats.isDirectory()) {
      throw new Error(`File input '${def.id}' must be a folder, got: ${absPath}`);
    }
    result[def.id] = absPath;
  }
  return result;
}

export async function installPlugin(opts: InstallOptions): Promise<InstalledPlugin> {
  const sourcePath = resolve(opts.source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Plugin source not found: ${sourcePath}`);
  }
  const pkgPath = join(sourcePath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json at ${sourcePath}`);
  }

  const pkgRaw = JSON.parse(await readFile(pkgPath, "utf-8")) as unknown;
  const parsed: ParsedPackage = parsePackage(pkgRaw);

  // Validate + materialise inputs/files *before* touching disk so any
  // missing-required failure rolls back cleanly with no half-installed state.
  const inputs = resolveInputs(parsed.manifest.inputs, opts.inputs);
  const files = await resolveFiles(parsed.manifest.files, opts.files);

  const home = resolveHome();
  const destDir = join(home, "plugins", parsed.name);

  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }
  await mkdir(destDir, { recursive: true });
  await cp(sourcePath, destDir, { recursive: true });

  const grantsDir = join(home, "grants");
  await mkdir(grantsDir, { recursive: true });
  const grantsPath = join(grantsDir, `${parsed.name}.json`);
  await writeFile(
    grantsPath,
    JSON.stringify(
      {
        name: parsed.name,
        version: parsed.version,
        installedAt: new Date().toISOString(),
        manifest: parsed.manifest,
        inputs,
        files,
      },
      null,
      2,
    ),
  );

  return { name: parsed.name, version: parsed.version, dest: destDir };
}
