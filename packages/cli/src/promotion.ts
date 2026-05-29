import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { type DitherConfig } from "./config";
import { resolveCollection, validateCollectionPath } from "./collection-registry";
import { grantsCover } from "./grants";
import { acquireTheme, releaseTheme } from "./locks";
import { updateIndex } from "./update-index";
import { needsReindexPath } from "./daemon-jobs";
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
 * Single entry point: `promote(opts) → { added, reindexDeferred }`.
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
  /** Collections this plugin is granted write access to. */
  grants: readonly string[];
  journal: RunHandle;
}

export interface PromoteResult {
  added: string[];
  reindexDeferred: boolean;
}

async function planPromotion(opts: PromoteOptions): Promise<Candidate[]> {
  const entries = await readdir(opts.runDir);
  const out: Candidate[] = [];
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
      if (existingSource !== opts.plugin) {
        throw new Error(
          `output ${filename} would clobber an existing entry at '${collection}/${filename}' (source=${
            typeof existingSource === "string" ? existingSource : "(missing)"
          }, this plugin=${opts.plugin})`,
        );
      }
    }
    out.push({ src, dest, collection, filename });
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
  const candidates = await planPromotion(opts);
  const added = await copyAdded(candidates);
  for (const path of added) {
    await opts.journal.append({ kind: "added", path });
  }

  if (added.length === 0) return { added, reindexDeferred: false };

  // qmd collections are top-level library subdirs (see store.ts), so a
  // multi-segment frontmatter `collection: "messages/inbox"` must be
  // narrowed to `"messages"` before being passed to updateIndex —
  // otherwise qmd's exact-name filter matches nothing and the index
  // silently stays stale.
  const touched = Array.from(
    new Set(candidates.map((c) => c.collection.split("/")[0]!)),
  );
  // qmd-index.lock coordinates with the daemon's job runner; if it's busy
  // (daemon is mid-indexing), defer by touching needs-reindex so the
  // daemon coalesces this into its next post-job reconciliation. Added
  // files are already on disk — only the rescan is deferred.
  const lock = await acquireTheme("index");
  if (lock === null) {
    await writeFile(needsReindexPath(), "", "utf-8").catch(() => undefined);
    await opts.journal.append({
      kind: "reindex-deferred",
      reason: "qmd-index.lock busy",
      touchedCollections: touched,
    });
    return { added, reindexDeferred: true };
  }
  try {
    await updateIndex(touched);
  } finally {
    await releaseTheme(lock);
  }
  return { added, reindexDeferred: false };
}
