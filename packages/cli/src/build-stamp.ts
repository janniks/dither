import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Build identity. `version` is SemVer core (MAJOR.MINOR.PATCH); a dev build
 * also carries `sha` (git short-sha) and `builtAt` (digits, no colons), which
 * compose the SemVer build-metadata suffix `+<sha>.<builtAt>`.
 */
export interface BuildStamp {
  version: string;
  sha: string;
  builtAt: string;
}

// Baked by tsdown `define` as a JSON string. Undefined when running un-bundled
// (vitest/tsx) — the fallback below keeps the accessor from throwing.
declare const __BUILD_STAMP__: string | undefined;

// dist/cli.mjs and dist/build-info.json are siblings, so the sidecar sits next
// to the bundled module that imports this file.
const here = dirname(fileURLToPath(import.meta.url));

function fallbackVersion() {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")).version as string;
  } catch {
    return "0.0.0";
  }
}

export function buildStamp(): BuildStamp {
  if (typeof __BUILD_STAMP__ === "undefined") {
    return { version: fallbackVersion(), sha: "dev", builtAt: "" };
  }
  return JSON.parse(__BUILD_STAMP__) as BuildStamp;
}

// SemVer string form: bare version in prod, `version+<sha>.<builtAt>` in dev.
export function stampString(stamp = buildStamp()): string {
  if (!stamp.sha || !stamp.builtAt) return stamp.version;
  return `${stamp.version}+${stamp.sha}.${stamp.builtAt}`;
}

export function buildVersion(): string {
  return buildStamp().version;
}

// Reader for the on-disk sidecar (the build currently on disk). ENOENT → null.
// Phase 2 reuses this to compare against the baked stamp.
export async function readBuildInfo(dir = join(here, "build-info.json")): Promise<BuildStamp | null> {
  try {
    return JSON.parse(await readFile(dir, "utf-8")) as BuildStamp;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
