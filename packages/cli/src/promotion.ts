import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { type DitherConfig } from "./config";
import { resolveCollection, validateCollectionPath } from "./collection-registry";
import { grantsCover } from "./grants";
import { acquireTheme, releaseTheme } from "./locks";
import { updateIndex } from "./update-index";
import { requestReindex } from "./markers";
import type { RunHandle } from "./run-log";

/**
 * Two-pass promotion: validate every `*.md` in the run dir against
 * frontmatter (`source` must equal plugin, `collection` must be granted
 * and registered), then copy. Validation throws before any file moves,
 * so a partial promote is impossible.
 *
 * Post-copy, request a qmd index update. If qmd-index.lock is held by
 * the daemon's job runner, write the `needs-reindex` marker so the
 * daemon coalesces this into its next post-job reconciliation; the
 * added files are already on disk.
 *
 * Cross-plugin dests without an edit grant are skipped (journaled as
 * `skipped`), never an error — see specs/twitter-hydrate.md.
 *
 * Single entry point: `promote(opts) → { added, skipped, reindexDeferred }`.
 */

interface ParsedFrontmatter {
  source?: unknown;
  collection?: unknown;
}

interface Candidate {
  src: string;
  dest: string;
  collection: string;
  filename: string;
}

export interface PromoteOptions {
  runDir: string;
  plugin: string;
  config: DitherConfig;
  /** Collections this plugin may create entries in. */
  grants: readonly string[];
  /** Collections where this plugin may overwrite entries other plugins
   *  created. Without cover here, a cross-source dest is skipped (never
   *  an error) so enriched entries survive re-imports untouched. */
  edits?: readonly string[];
  journal: RunHandle;
}

export interface PromoteResult {
  added: string[];
  /** Outputs left behind because the dest belongs to another plugin and
   *  no edit grant covers the collection. */
  skipped: string[];
  reindexDeferred: boolean;
}

interface Plan {
  copy: Candidate[];
  skipped: Candidate[];
}

async function planPromotion(opts: PromoteOptions): Promise<Plan> {
  const entries = await readdir(opts.runDir);
  const out: Plan = { copy: [], skipped: [] };
  for (const filename of entries) {
    if (!filename.endsWith(".md")) continue;
    const src = join(opts.runDir, filename);
    const content = await readFile(src, "utf-8");
    const data = matter(content).data as ParsedFrontmatter;

    const source = typeof data.source === "string" ? data.source : null;
    if (source !== opts.plugin) {
      throw new Error(
        `output ${filename} declares source=${source ?? "(missing)"}; expected ${opts.plugin}`,
      );
    }
    const collection = typeof data.collection === "string" ? data.collection : null;
    if (!collection) {
      throw new Error(`output ${filename} missing 'collection' frontmatter`);
    }
    validateCollectionPath(collection);
    if (!grantsCover(opts.grants, collection)) {
      throw new Error(
        `plugin '${opts.plugin}' is not granted write access to collection '${collection}'`,
      );
    }

    // Resolve the destination by top-segment lookup. External mounts win
    // when registered; otherwise the library auto-creates a subdir. The
    // qmd-side collection name is the top segment in either case (see
    // store.ts) so search and partial-reindex behave identically.
    const [top, ...rest] = collection.split("/");
    const resolved = resolveCollection(opts.config, top!);
    if (resolved?.source === "external" && resolved.status === "missing") {
      throw new Error(
        `output ${filename} targets external collection '${top}' but its path is missing: ${resolved.path}`,
      );
    }
    const destDir = resolved?.source === "external"
      ? (rest.length > 0 ? join(resolved.path, ...rest) : resolved.path)
      : join(opts.config.library.path, collection);
    const dest = join(destDir, filename);
    if (existsSync(dest)) {
      const existing = await readFile(dest, "utf-8");
      const existingSource = (matter(existing).data as ParsedFrontmatter).source;
      // Same source → normal sync refresh. Different source → allowed
      // only under an edit grant; otherwise skip this output (library is
      // append-only across plugins without consent).
      if (existingSource !== opts.plugin && !grantsCover(opts.edits ?? [], collection)) {
        out.skipped.push({ src, dest, collection, filename });
        continue;
      }
    }
    out.copy.push({ src, dest, collection, filename });
  }
  return out;
}

async function copyAdded(candidates: Candidate[]): Promise<string[]> {
  const added: string[] = [];
  for (const c of candidates) {
    await mkdir(join(c.dest, ".."), { recursive: true });
    await copyFile(c.src, c.dest);
    added.push(c.dest);
  }
  return added;
}

export async function promote(opts: PromoteOptions): Promise<PromoteResult> {
  const plan = await planPromotion(opts);
  for (const c of plan.skipped) {
    await opts.journal.append({
      kind: "skipped",
      path: c.dest,
      reason: `entry belongs to another plugin and '${opts.plugin}' has no edit grant for '${c.collection}'`,
    });
  }
  const added = await copyAdded(plan.copy);
  for (const path of added) {
    await opts.journal.append({ kind: "added", path });
  }
  const skipped = plan.skipped.map((c) => c.dest);

  if (added.length === 0) return { added, skipped, reindexDeferred: false };

  // qmd collections are top-level library subdirs (see store.ts), so a
  // multi-segment frontmatter `collection: "messages/inbox"` must be
  // narrowed to `"messages"` before being passed to updateIndex —
  // otherwise qmd's exact-name filter matches nothing and the index
  // silently stays stale.
  const touched = Array.from(
    new Set(plan.copy.map((c) => c.collection.split("/")[0]!)),
  );
  // qmd-index.lock coordinates with the daemon's job runner; if it's busy
  // (daemon is mid-indexing), defer by touching needs-reindex so the
  // daemon coalesces this into its next post-job reconciliation. Added
  // files are already on disk — only the rescan is deferred.
  const lock = await acquireTheme("index");
  if (lock === null) {
    await requestReindex().catch(() => undefined);
    await opts.journal.append({
      kind: "reindex-deferred",
      reason: "qmd-index.lock busy",
      touchedCollections: touched,
    });
    return { added, skipped, reindexDeferred: true };
  }
  try {
    await updateIndex(touched);
  } finally {
    await releaseTheme(lock);
  }
  return { added, skipped, reindexDeferred: false };
}
