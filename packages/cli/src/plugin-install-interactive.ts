import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parsePackage, type Manifest, type ParsedPackage } from "./manifest";
import {
  confirm,
  promptSelect,
  promptText,
  untildePath,
} from "./prompt";
import { getGlobalEnv } from "./global-env";
import { resolveHome } from "./home";

/**
 * Normalize a path string typed at a prompt. Handles three muscle-memory
 * traps from shell:
 *   - `~/foo`   → `<home>/foo`
 *   - `~`       → `<home>`
 *   - `foo\ bar`→ `foo bar` (shell-style backslash escapes)
 *   - quoted strings → unwrapped
 */
function normalizePath(raw: string): string {
  let v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  v = v.replace(/\\(.)/g, "$1");
  return untildePath(v);
}

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

export class InstallCancelledError extends Error {
  constructor() {
    super("install cancelled.");
    this.name = "InstallCancelledError";
  }
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
    const inputPath = resolve(normalizePath(userValue));
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

/**
 * Read + parse a plugin's package.json. Same code path used by
 * `installPlugin`, exposed so the CLI's interactive layer can plan
 * before kicking off the install.
 */
/**
 * Read a plugin's existing grants file, if any. Returns the previously
 * persisted answers as a partial `InstallInputs` — the caller layers
 * these under the user's current flag inputs (flags win) so reinstall
 * is Enter-through unless the user wants to change something.
 */
export async function readExistingGrants(name: string): Promise<InstallInputs | null> {
  const grantsPath = join(resolveHome(), "grants", `${name}.json`);
  if (!existsSync(grantsPath)) return null;
  try {
    const blob = JSON.parse(await readFile(grantsPath, "utf-8")) as {
      env?: Record<string, string>;
      envRefs?: string[];
      files?: Record<string, string>;
      net?: string[];
      collections?: string[];
    };
    return {
      env: blob.env,
      envRefs: blob.envRefs,
      files: blob.files,
      net: blob.net,
      collections: blob.collections,
    };
  } catch {
    // Corrupt grants file shouldn't block reinstall — treat as fresh.
    return null;
  }
}

export async function readPackage(source: string): Promise<ParsedPackage> {
  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Plugin source not found: ${sourcePath}`);
  }
  const pkgPath = join(sourcePath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json at ${sourcePath}`);
  }
  return parsePackage(JSON.parse(await readFile(pkgPath, "utf-8")));
}

/**
 * Run the full interactive review on a TTY install. Walks every declared
 * env / file / net host / collection in the manifest:
 *   - missing required env → select (literal vs read-from-global)
 *   - missing required file → text prompt with existence validation
 *   - declared net hosts → multi-select pre-checked against current grant
 *   - declared collections → multi-select + pattern-validated add-loop
 *
 * Inputs that were already supplied via CLI flags pre-fill the prompt's
 * default state and the user can adjust from there.
 *
 * Returns a partial `InstallInputs` — the caller merges with the
 * original flag inputs (prompt wins) and feeds the result to
 * `installPlugin`.
 */
export async function promptInteractive(
  parsed: ParsedPackage,
  current: InstallInputs,
  missing: MissingField[],
): Promise<InstallInputs> {
  printHeader(parsed);

  const env: Record<string, string> = {};
  const envRefs: string[] = [];
  const files: Record<string, string> = {};

  for (const field of missing) {
    if (field.kind === "env") {
      const def = (parsed.manifest.env ?? []).find((e) => e.name === field.name);
      const desc = def?.description ? ` — ${def.description}` : "";
      // Only show the literal-vs-ref select when a matching global env value
      // actually exists; otherwise "ref" has no value to read and the choice
      // is meaningless. Single ask → single line in scrollback.
      const globalValue = await getGlobalEnv(field.name);
      if (globalValue !== undefined) {
        const mode = await promptSelect<"literal" | "ref">({
          message: `${field.name}${desc}`,
          options: [
            { label: "Read from global dither env", value: "ref" },
            { label: "Enter a new literal value", value: "literal" },
          ],
        });
        if (mode === "ref") {
          envRefs.push(field.name);
          confirm(field.name, "(global)");
          continue;
        }
      }
      const value = await promptText({
        message: `${field.name}${desc}`,
      });
      env[field.name] = value;
      confirm(field.name, value);
      continue;
    }
    // kind === "file"
    const def = (parsed.manifest.files ?? []).find((f) => f.id === field.name);
    const label = def?.name ?? field.name;
    const hint = def?.default_hint ? ` (${def.default_hint})` : "";
    const dflt = def?.default;
    const value = await promptText({
      message: `Path for ${label}${hint}`,
      default: dflt,
      placeholder: dflt,
      validate: (v) => {
        const t = v.trim();
        if (!t) return "path cannot be empty";
        const abs = resolve(normalizePath(t));
        if (!existsSync(abs)) return `path does not exist: ${abs}`;
        return null;
      },
    });
    const final = normalizePath(value);
    files[field.name] = final;
    confirm(field.name, final);
  }

  // Manifest is the source of truth for net + collections. The user
  // overrides via --allow-net / --allow-collection flags; otherwise we
  // grant exactly what the manifest declares. No picker, no add-loop —
  // both add friction without saving anything most installs need.
  const net = accept("net", current.net, parsed.manifest.net);
  const collections = accept(
    "collections",
    current.collections,
    parsed.manifest.collections,
  );

  return { env, envRefs, files, net, collections };
}

/**
 * Resolve a grant list from a flag override or manifest declaration. Prints
 * a single `✓ label: a, b, c` line so the user sees what was granted.
 * Returns undefined when both are empty (so `mergeInputs` no-ops).
 */
function accept(
  label: string,
  flag: string[] | undefined,
  declared: string[] | undefined,
): string[] | undefined {
  const chosen = flag !== undefined && flag.length > 0
    ? Array.from(new Set(flag))
    : declared && declared.length > 0
    ? Array.from(new Set(declared))
    : [];
  if (chosen.length === 0) return undefined;
  confirm(label, chosen.join(", "));
  return chosen;
}

/**
 * Title-only header at the top of an interactive install. Plugin
 * decorations (icon, tagline) are deliberately omitted — a plugin can't
 * use a flashy header to mislead about what's about to be installed.
 * Capped at ~60 chars so it fits on one line in a narrow terminal.
 */
function printHeader(parsed: ParsedPackage): void {
  const title = parsed.manifest.display_name ?? parsed.name;
  const full = `${title}@${parsed.version}`;
  const line = full.length > 60 ? `${full.slice(0, 57)}…` : full;
  process.stdout.write(`\n${line}\n\n`);
}

/**
 * Merge a partial `InstallInputs` (from prompts) on top of the user's
 * original inputs. The partial wins for any field it provides.
 */
export function mergeInputs(base: InstallInputs, extra: InstallInputs): InstallInputs {
  return {
    env: { ...base.env, ...extra.env },
    envRefs: Array.from(new Set([...(base.envRefs ?? []), ...(extra.envRefs ?? [])])),
    files: { ...base.files, ...extra.files },
    net: extra.net ?? base.net,
    collections: extra.collections ?? base.collections,
  };
}

