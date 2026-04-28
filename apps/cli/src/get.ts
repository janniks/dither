import { openStore } from "./store";

export interface GetOptions {
  /** Display path (e.g. `notes/auth.md`) or qmd docid (e.g. `#abc123`). */
  ref: string;
  /** Inclusive 1-based start line. */
  fromLine?: number;
  /** Inclusive 1-based end line. */
  toLine?: number;
}

export async function get(opts: GetOptions): Promise<string | null> {
  const store = await openStore();
  if (!store) {
    return null;
  }

  if (opts.fromLine !== undefined || opts.toLine !== undefined) {
    const fromLine = opts.fromLine ?? 1;
    const maxLines =
      opts.toLine !== undefined ? Math.max(0, opts.toLine - fromLine + 1) : undefined;
    return await store.getDocumentBody(opts.ref, { fromLine, maxLines });
  }

  return await store.getDocumentBody(opts.ref);
}
