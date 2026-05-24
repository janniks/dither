import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parsePackage, type Manifest, type ParsedPackage } from "./manifest";
import {
  confirm,
  pluginText,
  promptMultiSelect,
  promptSelect,
  promptText,
  untildePath,
} from "./prompt";
import { getGlobalEnv } from "./global-env";
import { resolveHome } from "./home";
import { parseSchedule } from "./schedule-parser";
import { Cron } from "croner";
import pc from "picocolors";

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
 * The user's effective watch declaration. Same shape as the manifest's
 * `watch` block — copied through to grants when the user opts in.
 */
export interface WatchChoice {
  collections: string[];
  glob?: string;
}

/**
 * Inputs the user supplied (via flags or, later, interactive prompts).
 * Mirrors `InstallOptions` minus the `source` path.
 *
 * `schedule` / `watch` carry the user's consented choice:
 *   - `undefined` — not yet decided (planInstall fills from the manifest)
 *   - `null`      — explicitly disabled (manual-only)
 *   - value       — effective schedule string / watch declaration
 */
export interface InstallInputs {
  env?: Record<string, string>;
  envRefs?: string[];
  files?: Record<string, string>;
  net?: string[];
  collections?: string[];
  schedule?: string | null;
  watch?: WatchChoice | null;
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
  schedule: string | null;
  watch: WatchChoice | null;
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
  // Schedule / watch default to the manifest declaration when the user
  // hasn't decided — preserves the legacy non-TTY install path. The TTY
  // prompt layer sets these explicitly (string or null) before planning.
  const schedule = inputs.schedule === undefined
    ? parsed.manifest.schedule ?? null
    : inputs.schedule;
  const watch = inputs.watch === undefined
    ? parsed.manifest.watch
      ? { collections: [...parsed.manifest.watch.collections], ...(parsed.manifest.watch.glob ? { glob: parsed.manifest.watch.glob } : {}) }
      : null
    : inputs.watch;
  if (missing.length > 0) {
    return { ok: false, missing, partial: { env, envRefs, files, net, collections, schedule, watch } };
  }
  return { ok: true, resolved: { env, envRefs, files, net, collections, schedule, watch } };
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
  opts: InstallInputs,
  existing: InstallInputs | null,
): Promise<InstallInputs> {
  const current: InstallInputs = existing ? mergeInputs(existing, opts) : opts;
  printHeader(parsed);
  // Skip the top-level package description when at least one per-field
  // prompt below will render its own `from plugin` box — back-to-back
  // identical chrome reads as a rendering bug.
  if (parsed.description && !hasFieldDescription(parsed)) {
    pluginText(parsed.description);
  }

  const env: Record<string, string> = {};
  const envRefs: string[] = [];
  const files: Record<string, string> = {};

  // Walk every env declaration in the manifest. Flag-supplied values
  // skip the prompt; otherwise prompt with default = prior ?? manifest.
  // No silent take of manifest defaults — see specs/plugin-install-consent.md.
  for (const def of parsed.manifest.env ?? []) {
    if (opts.env?.[def.name] !== undefined) continue;
    if (opts.envRefs?.includes(def.name)) continue;
    if (def.description) pluginText(def.description);
    const priorLit = existing?.env?.[def.name];
    const priorRef = existing?.envRefs?.includes(def.name) ?? false;
    const globalValue = await getGlobalEnv(def.name);
    if (globalValue !== undefined) {
      const mode = await promptSelect<"literal" | "ref">({
        message: def.name,
        options: [
          { label: "Read from global dither env", value: "ref" },
          { label: "Enter a new literal value", value: "literal" },
        ],
        initial: priorRef ? "ref" : "literal",
      });
      if (mode === "ref") {
        envRefs.push(def.name);
        confirm(def.name, "(global)");
        continue;
      }
    }
    const dflt = priorLit ?? def.default;
    const value = await promptText({ message: def.name, default: dflt });
    env[def.name] = value;
    confirm(def.name, value);
  }

  // Walk every file declaration. Flag-supplied skips. Optional files with
  // no prior and no manifest default skip silently (no meaningful default
  // to confirm). Required-or-defaulted files prompt with the prior value
  // pre-filled when reinstalling.
  for (const def of parsed.manifest.files ?? []) {
    if (opts.files?.[def.id] !== undefined) continue;
    const priorPath = existing?.files?.[def.id];
    const dflt = priorPath ?? def.default;
    if (!def.required && !dflt) continue;
    if (def.description) pluginText(def.description);
    const value = await promptText({
      message: def.id,
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
    files[def.id] = final;
    confirm(def.id, final);
  }

  // Consent for list-shaped grants: flag-supplied values skip the prompt
  // entirely; otherwise the multi-select shows `prior ∪ manifest`, pre-checked
  // per `buildListOptions`. Manifest-only entries (new since last install)
  // start unchecked with a `(new)` hint — silent-widen across plugin updates
  // becomes impossible. See specs/plugin-install-consent.md.
  const net = await consentList("net", opts.net, existing?.net, parsed.manifest.net);
  const collections = await consentList(
    "collections",
    opts.collections,
    existing?.collections,
    parsed.manifest.collections,
  );

  const schedule = await promptScheduleConsent(parsed, current.schedule);
  const watch = await promptWatchConsent(parsed, current.watch);

  return { env, envRefs, files, net, collections, schedule, watch };
}

/**
 * Schedule consent. Returns the user's effective cron (string), `null`
 * for manual-only, or `undefined` if the plugin doesn't declare a
 * schedule (so no consent step ran).
 *
 * Pre-fills the highlighted option from `current` when reinstalling.
 */
async function promptScheduleConsent(
  parsed: ParsedPackage,
  current: string | null | undefined,
): Promise<string | null | undefined> {
  const declared = parsed.manifest.schedule;
  if (!declared) return undefined;
  const cadence = humanizeSchedule(declared);
  const initial: "declared" | "manual" | "custom" =
    current === undefined
      ? "declared"
      : current === null
      ? "manual"
      : current === declared
      ? "declared"
      : "custom";
  const choice = await promptSelect<"declared" | "manual" | "custom">({
    message: `schedule — enable?`,
    options: [
      { label: `Enable ${cadence} (recommended by plugin)`, value: "declared" },
      { label: `Manual only — fire with 'dither plugin run ${parsed.name}'`, value: "manual" },
      { label: "Custom schedule…", value: "custom" },
    ],
    initial,
  });
  if (choice === "declared") {
    confirm("schedule", `${cadence} (${declared})`);
    return declared;
  }
  if (choice === "manual") {
    confirm("schedule", "manual only");
    return null;
  }
  process.stdout.write(
    `${pc.dim(
      "formats: 'every 15m', 'every 2h', 'daily at 9am', 'daily at 14:30', or a cron expression (e.g. '0 9 * * 1-5')",
    )}\n`,
  );
  const custom = await promptText({
    message: "custom schedule",
    ...(current && current !== declared ? { default: current } : {}),
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return "schedule cannot be empty";
      try {
        parseSchedule(trimmed);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
  const final = custom.trim();
  confirm("schedule", `${humanizeSchedule(final)} (${final})`);
  return final;
}

/**
 * Watch consent. Y/n confirm for plugins that declare `watch.collections`.
 * Returns the declared watch block on yes, `null` on no, `undefined` if
 * the plugin doesn't declare a watch step.
 */
async function promptWatchConsent(
  parsed: ParsedPackage,
  current: WatchChoice | null | undefined,
): Promise<WatchChoice | null | undefined> {
  const declared = parsed.manifest.watch;
  if (!declared || declared.collections.length === 0) return undefined;
  const initial: "enable" | "disable" = current === null ? "disable" : "enable";
  const summary = declared.collections.join(", ");
  const choice = await promptSelect<"enable" | "disable">({
    message: `watch — runs automatically when files in ${summary} change. enable?`,
    options: [
      { label: "Enable", value: "enable" },
      { label: "Disable — run manually only", value: "disable" },
    ],
    initial,
  });
  if (choice === "disable") {
    confirm("watch", "disabled");
    return null;
  }
  confirm("watch", summary);
  return {
    collections: [...declared.collections],
    ...(declared.glob ? { glob: declared.glob } : {}),
  };
}

/**
 * Render a cron pattern as a short human cadence string for the consent
 * prompt. Best-effort: returns the raw pattern when nothing matches. Uses
 * croner indirectly via two `nextRun` calls so it handles 5- and 6-field
 * crons plus the shorthand syntaxes that `parseSchedule` accepts.
 */
export function humanizeSchedule(pattern: string): string {
  try {
    const cron = parseSchedule(pattern);
    const job = new Cron(cron);
    const a = job.nextRun();
    const b = a ? job.nextRun(a) : null;
    if (!a || !b) return pattern;
    const sec = Math.round((b.getTime() - a.getTime()) / 1000);
    if (sec < 60) return `every ${sec} seconds`;
    const min = sec / 60;
    if (min < 60 && Number.isInteger(min)) {
      return min === 1 ? "every minute" : `every ${min} minutes`;
    }
    const hr = min / 60;
    if (hr < 24 && Number.isInteger(hr)) {
      return hr === 1 ? "every hour" : `every ${hr} hours`;
    }
    const day = hr / 24;
    if (Number.isInteger(day)) {
      return day === 1 ? "daily" : `every ${day} days`;
    }
    return pattern;
  } catch {
    return pattern;
  }
}

/**
 * One option in the consent multi-select for a list-shaped grant.
 * Exported for unit-testing `buildListOptions` in isolation.
 */
export interface ListOption {
  value: string;
  /** Whether the multi-select starts with this entry checked. */
  initial: boolean;
  /** `(new)` for manifest-new-since-last-install,
   *  `(plugin no longer requests)` for prior-only entries. */
  hint?: string;
}

/**
 * Pure: compute the multi-select option list for a list-shaped grant
 * (`net`, `collections`) from the prior grants and the manifest's
 * current declaration.
 *
 *   Fresh install (prior=undefined): every manifest entry pre-checked.
 *   Reinstall + unchanged:           every manifest entry pre-checked.
 *   Reinstall + manifest added:      new entry unchecked, `(new)` hint —
 *                                    the silent-widen guard.
 *   Reinstall + manifest dropped:    prior entry pre-checked,
 *                                    `(plugin no longer requests)` hint.
 *
 * Order: manifest first (manifest order preserved), then prior-only entries.
 */
export function buildListOptions(
  prior: string[] | undefined,
  manifest: string[] | undefined,
): ListOption[] {
  const priorSet = new Set(prior ?? []);
  const manifestArr = manifest ?? [];
  const manifestSet = new Set(manifestArr);
  const hasPrior = prior !== undefined;
  const out: ListOption[] = manifestArr.map((value) => {
    if (!hasPrior || priorSet.has(value)) return { value, initial: true };
    return { value, initial: false, hint: "(new)" };
  });
  for (const value of prior ?? []) {
    if (manifestSet.has(value)) continue;
    out.push({ value, initial: true, hint: "(plugin no longer requests)" });
  }
  return out;
}

/**
 * Consent prompt for a list-shaped grant. Flag-supplied value bypasses
 * the prompt (the flag IS the user's input); otherwise drives a
 * multi-select over `prior ∪ manifest` per `buildListOptions`. Returns
 * `undefined` when there's nothing to consent to (no flag, no prior, no
 * manifest entry) so `mergeInputs` doesn't clobber.
 */
async function consentList(
  label: string,
  flag: string[] | undefined,
  prior: string[] | undefined,
  manifest: string[] | undefined,
): Promise<string[] | undefined> {
  if (flag !== undefined && flag.length > 0) {
    const list = Array.from(new Set(flag));
    confirm(label, list.join(", "));
    return list;
  }
  const options = buildListOptions(prior, manifest);
  if (options.length === 0) return undefined;
  const selected = await promptMultiSelect({
    message: label,
    options: options.map((o) => ({
      value: o.value,
      label: o.value,
      ...(o.hint ? { hint: o.hint } : {}),
    })),
    initial: options.filter((o) => o.initial).map((o) => o.value),
  });
  confirm(label, selected.length > 0 ? selected.join(", ") : "(none)");
  return selected;
}

/**
 * Title-only header at the top of an interactive install. Plugin
 * decorations (icon, tagline) are deliberately omitted — a plugin can't
 * use a flashy header to mislead about what's about to be installed.
 * Capped at ~60 chars so it fits on one line in a narrow terminal.
 */
/**
 * True when any env / file declaration has a non-empty description — those
 * render their own `from plugin` box, so the package-level description box
 * directly above them would just stack identical chrome.
 */
export function hasFieldDescription(parsed: ParsedPackage): boolean {
  const fields = [
    ...(parsed.manifest.env ?? []),
    ...(parsed.manifest.files ?? []),
  ];
  return fields.some((f) => f.description && f.description.trim() !== "");
}

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
    schedule: extra.schedule !== undefined ? extra.schedule : base.schedule,
    watch: extra.watch !== undefined ? extra.watch : base.watch,
  };
}

