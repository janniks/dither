import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths";

/**
 * Marker — the lazy form of Signal. A zero-byte presence flag at
 * `<config>/markers/<name>` that the daemon checks on its next cycle.
 *
 * Two markers live today:
 *   - `needs-reindex` (request flavour): any non-daemon writer touches this
 *     when the qmd-index lock was busy. The daemon's index loop atomically
 *     claims it (rename → `.processing`), runs the job, then unlinks the
 *     claim file. New writes during the cycle land on a fresh marker file
 *     and are picked up by the next cycle.
 *   - `embed-disabled` (state flavour): `dither index cancel` writes it;
 *     the embed loop checks between iterations and exits early. Cleared
 *     by `dither index update`.
 *
 * See CONTEXT.md ("Marker"). Markers compose with Signal — write a
 * marker + send SIGHUP = "do this now AND remember it."
 */

const NEEDS_REINDEX = "needs-reindex";
const EMBED_DISABLED = "embed-disabled";

// Auto-migration from the legacy top-level paths. Runs once per resolved
// dir — tests using a fresh DITHER_DIR get a fresh migration. Sync I/O
// so callers that are themselves sync (claimReindex, disableEmbed) can
// migrate before their first read/write.
const migrated = new Set<string>();

function markersDir(): string {
  return join(configDir(), "markers");
}

function ensureMigrated(): void {
  const dir = configDir();
  if (migrated.has(dir)) return;
  migrated.add(dir);
  mkdirSync(markersDir(), { recursive: true });
  for (const name of [NEEDS_REINDEX, EMBED_DISABLED]) {
    const oldPath = join(dir, name);
    const newPath = join(markersDir(), name);
    if (!existsSync(oldPath)) continue;
    if (existsSync(newPath)) {
      // Both exist — keep the new one, drop the legacy artefact.
      unlinkSync(oldPath);
      continue;
    }
    renameSync(oldPath, newPath);
  }
}

/** Test-only: forget the migration latch so a subsequent call re-migrates. */
export function _resetMarkersMigrationLatch(): void {
  migrated.clear();
}

export function needsReindexPath(): string {
  return join(markersDir(), NEEDS_REINDEX);
}

export function embedDisabledPath(): string {
  return join(markersDir(), EMBED_DISABLED);
}

/** Async write — ask the daemon's index loop to run on its next cycle. */
export async function requestReindex(): Promise<void> {
  ensureMigrated();
  await mkdir(markersDir(), { recursive: true });
  await writeFile(needsReindexPath(), "", "utf-8");
}

/** Sync write — for CLI paths that need the marker to land before SIGHUP. */
export function requestReindexSync(): void {
  ensureMigrated();
  mkdirSync(markersDir(), { recursive: true });
  writeFileSync(needsReindexPath(), "", "utf-8");
}

/** Unlink the reindex marker. No-op if absent. */
export function clearReindex(): void {
  ensureMigrated();
  try {
    unlinkSync(needsReindexPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Atomic claim of the reindex marker: rename it to `.processing` so any
 * write that arrives during the cycle lands on a fresh marker.
 * Returns true if the caller now owns the claim and must call
 * `releaseReindexClaim` once the job is done. False if no marker existed.
 */
export function claimReindex(): boolean {
  ensureMigrated();
  try {
    renameSync(needsReindexPath(), `${needsReindexPath()}.processing`);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Drop the `.processing` claim file. No-op if already gone. */
export function releaseReindexClaim(): void {
  try {
    unlinkSync(`${needsReindexPath()}.processing`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export function disableEmbed(): void {
  ensureMigrated();
  mkdirSync(markersDir(), { recursive: true });
  writeFileSync(embedDisabledPath(), "", "utf-8");
}

export function enableEmbed(): void {
  ensureMigrated();
  try {
    unlinkSync(embedDisabledPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export interface MarkerState {
  needsReindex: boolean;
  embedDisabled: boolean;
}

export function readMarkerState(): MarkerState {
  ensureMigrated();
  return {
    needsReindex: existsSync(needsReindexPath()),
    embedDisabled: existsSync(embedDisabledPath()),
  };
}
