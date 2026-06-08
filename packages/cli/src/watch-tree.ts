import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";

/**
 * Native `fs.watch` tree watcher — the daemon's only file-watching primitive.
 * Replaces chokidar, which (since it dropped bundled fsevents) opens one
 * `fs.watch` fd per *file* on macOS, exhausting the process fd table on large
 * collections. This uses the OS recursive primitive where it exists, so a huge
 * flat collection costs O(1)–O(dirs) fds, not O(files). No native binary.
 *
 *   macOS / Windows — one `fs.watch(root, { recursive: true })` per root.
 *     libuv wraps FSEvents / ReadDirectoryChangesW: a single handle covers the
 *     whole subtree and picks up new subdirs automatically.
 *   Linux — `recursive` is unsupported/buggy, so walk each root and
 *     `fs.watch(dir)` per directory (inotify, one fd per dir). New directories
 *     are watched dynamically when their creation event arrives.
 *
 * Contract: `onEvent(absolutePath, kind)` fires only for paths that currently
 * exist and are files. Deletions and directories are swallowed (a directory on
 * Linux instead arms a new watch). The caller owns globbing/dedup. `close()`
 * releases every watch.
 */

export type WatchKind = "add" | "change";
export type OnEvent = (path: string, kind: WatchKind) => void;

export interface TreeWatch {
  close(): void;
}

const recursive = process.platform === "darwin" || process.platform === "win32";

export function watchTree(roots: readonly string[], onEvent: OnEvent): TreeWatch {
  const watchers = new Map<string, FSWatcher>();

  const emit = (full: string, type: string): void => {
    const s = statSync(full, { throwIfNoEntry: false });
    if (!s) return; // deletion or transient
    if (s.isDirectory()) {
      if (!recursive) arm(full); // Linux: a new subtree appeared
      return;
    }
    onEvent(full, type === "change" ? "change" : "add");
  };

  function arm(dir: string): void {
    if (watchers.has(dir)) return;
    const s = statSync(dir, { throwIfNoEntry: false });
    if (!s?.isDirectory()) return; // not yet created — reconcile/recover backfills

    const w = watch(dir, { recursive }, (type, name) => {
      if (name === null) return;
      emit(join(dir, name), type);
    });
    w.on("error", () => {
      w.close();
      watchers.delete(dir);
    });
    watchers.set(dir, w);

    if (recursive) return; // OS covers the subtree
    for (const sub of subdirs(dir)) arm(sub);
  }

  for (const r of roots) arm(r);

  return {
    close() {
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

/** Immediate child directories of `dir`, skipping symlinks. ENOENT → []. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}
