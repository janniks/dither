import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Manifest, ParsedPackage } from "./manifest";

/**
 * Inputs the user supplied (via flags or, later, interactive prompts).
 * Mirrors `InstallOptions` minus the `source` path.
 */
export interface InstallInputs {
  env?: Record<string, string>;
  envRefs?: string[];
  files?: Record<string, string>;
  net?: string[];
  collections?: string[];
}

/**
 * Fully-resolved values ready to write to the grants file.
 */
export interface ResolvedInputs {
  env: Record<string, string>;
  envRefs: string[];
  files: Record<string, string>;
  net: string[];
  collections: string[];
}

/**
 * What the planner found. `ok: false` means at least one *required* manifest
 * declaration (env without default, file marked required) had no input —
 * the install can't proceed without those fields, but the planner returns
 * everything else it could resolve so the prompt layer can pre-fill the
 * non-missing fields.
 */
export type PlanResult =
  | { ok: true; resolved: ResolvedInputs }
  | { ok: false; missing: MissingField[]; partial: ResolvedInputs };

export interface MissingField {
  kind: "env" | "file";
  name: string;
}

export class MissingInputsError extends Error {
  readonly missing: MissingField[];
  constructor(missing: MissingField[]) {
    super(formatMissing(missing));
    this.missing = missing;
    this.name = "MissingInputsError";
  }
}

export function formatMissing(missing: MissingField[]): string {
  const envs = missing.filter((m) => m.kind === "env").map((m) => m.name);
  const files = missing.filter((m) => m.kind === "file").map((m) => m.name);
  const parts: string[] = [];
  if (envs.length > 0) parts.push(`env: ${envs.join(", ")}`);
  if (files.length > 0) parts.push(`file: ${files.join(", ")}`);
  return `missing required ${parts.join("; ")}. pass --env / --file or run on a TTY for interactive setup.`;
}

function resolveEnvCollect(
  declared: Manifest["env"],
  provided: Record<string, string> | undefined,
  envRefs: string[],
  missing: MissingField[],
): Record<string, string> {
  const result: Record<string, string> = {};
  const refSet = new Set(envRefs);
  for (const def of declared ?? []) {
    const userValue = provided?.[def.name];
    if (userValue !== undefined) {
      result[def.name] = userValue;
      continue;
    }
    if (refSet.has(def.name)) continue;
    if (def.default !== undefined) {
      result[def.name] = def.default;
      continue;
    }
    missing.push({ kind: "env", name: def.name });
  }
  return result;
}

async function resolveFilesCollect(
  declared: Manifest["files"],
  provided: Record<string, string> | undefined,
  missing: MissingField[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const def of declared ?? []) {
    const userValue = provided?.[def.id];
    if (userValue === undefined) {
      if (def.required) missing.push({ kind: "file", name: def.id });
      continue;
    }
    const inputPath = resolve(userValue);
    if (!existsSync(inputPath)) {
      throw new Error(`File '${def.id}' path does not exist: ${inputPath}`);
    }
    // Canonicalise at install. Symlink swap later mustn't silently widen
    // the grant.
    const absPath = await realpath(inputPath);
    const stats = await lstat(absPath);
    if (def.kind === "file" && !stats.isFile()) {
      throw new Error(`File '${def.id}' must be a file, got: ${absPath}`);
    }
    if (def.kind === "folder" && !stats.isDirectory()) {
      throw new Error(`File '${def.id}' must be a folder, got: ${absPath}`);
    }
    result[def.id] = absPath;
  }
  return result;
}

function resolveAllowList(
  declared: string[] | undefined,
  provided: string[] | undefined,
): string[] {
  if (!provided || provided.length === 0) return Array.from(new Set(declared ?? []));
  return Array.from(new Set(provided));
}

/**
 * Walk the manifest and the user's inputs, collect every missing required
 * field in one pass. Pure-ish: only I/O is the realpath/lstat on provided
 * file paths.
 *
 * In phase 1 the planner only feeds `installPlugin`'s pre-flight check
 * (so non-TTY runs enumerate all missing fields in one error). Later
 * phases extend it to drive the interactive prompt flow.
 */
export async function planInstall(
  parsed: ParsedPackage,
  inputs: InstallInputs,
): Promise<PlanResult> {
  const missing: MissingField[] = [];
  const envRefs = inputs.envRefs ?? [];
  const env = resolveEnvCollect(parsed.manifest.env, inputs.env, envRefs, missing);
  const files = await resolveFilesCollect(parsed.manifest.files, inputs.files, missing);
  const net = resolveAllowList(parsed.manifest.net, inputs.net);
  const collections = resolveAllowList(parsed.manifest.collections, inputs.collections);
  if (missing.length > 0) {
    return { ok: false, missing, partial: { env, envRefs, files, net, collections } };
  }
  return { ok: true, resolved: { env, envRefs, files, net, collections } };
}
