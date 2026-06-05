import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHome } from "./home";

/**
 * Durable, per-identity, at-least-once queue. The deep module behind every
 * fire source. Generalizes the prototype in `inbox.ts` (claim = atomic
 * rename pending→inflight; ack = unlink; restore = append back; recover =
 * re-queue orphans) so kicks, inbox, refires, and the future watcher /
 * scheduler all share one durability implementation.
 *
 * Surface is small by design — `enqueue` plus either the coupled `drain`
 * (claim → run → ack|restore in one call) or the decoupled `claim` / `ack` /
 * `restore` lease (for the inbox, whose run is an async external child). It
 * hides the storage shape, atomic tmp+rename, dedup, and the inflight lease.
 *
 * Two storage shapes, one mechanism:
 *
 *  - `latest` — at most one pending item per identity; a fresh enqueue
 *    replaces it (latest-wins). The kick queue is this degenerate case.
 *  - `log` — an append-log of many items, deduped at claim time by an
 *    optional `key`. The watch inbox is this case.
 *
 * Pending lives at `<dir>/<name>.<ext>`; the claim leases it to
 * `<dir>/inflight/<name>.<ext>`. A crash between claim and ack leaves the
 * inflight file on disk; `recover()` re-queues it at boot.
 */

export type Outcome = "done" | "retry";

export interface QueueConfig<T> {
  /** Sub-directory under `<home>` holding pending files (e.g. "kicks"). */
  dir: string;
  /** File extension for one identity's pending file (e.g. "json", "ndjson"). */
  ext: string;
  /** `latest` = single-value latest-wins; `log` = append + dedup. */
  shape: "latest" | "log";
  /** Dedup key (log shape only). Items sharing a key collapse, last wins. */
  key?: (item: T) => string;
  /**
   * Tie-break for two items sharing a `key`. Returns the one to keep. Default
   * is last-appended-wins. The inbox overrides this to keep the latest mtime.
   */
  prefer?: (a: T, b: T) => T;
  /**
   * Sub-directory under `<home>` for the inflight lease. Defaults to
   * `<dir>/inflight`. The inbox overrides it to `inflight` so the lease lands
   * at `<home>/inflight/<name>.<ext>` (its established on-disk layout).
   */
  inflightDir?: string;
}

export class Queue<T> {
  private cfg: QueueConfig<T>;

  constructor(cfg: QueueConfig<T>) {
    this.cfg = cfg;
  }

  private base(): string {
    return join(resolveHome(), this.cfg.dir);
  }

  private pending(name: string): string {
    assertSafe(name);
    return join(this.base(), `${name}.${this.cfg.ext}`);
  }

  private inflightBase(): string {
    if (this.cfg.inflightDir) return join(resolveHome(), this.cfg.inflightDir);
    return join(this.base(), "inflight");
  }

  private inflight(name: string): string {
    assertSafe(name);
    return join(this.inflightBase(), `${name}.${this.cfg.ext}`);
  }

  /** Durably enqueue one item. Atomic; latest-wins or append per shape. */
  async enqueue(name: string, item: T): Promise<void> {
    const file = this.pending(name);
    await mkdir(this.base(), { recursive: true });
    if (this.cfg.shape === "latest") {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, serialize(item));
      await rename(tmp, file);
      return;
    }
    await appendFile(file, serialize(item));
  }

  /**
   * Claim every pending item, run each through `run`, then ack (`"done"`)
   * or restore (`"retry"` or throw). Claim atomically leases pending →
   * inflight so producers appending mid-drain land in a fresh pending file
   * and survive for the next drain. Returns the items processed.
   */
  async drain(name: string, run: (item: T) => Promise<Outcome>): Promise<T[]> {
    const items = await this.claim(name);
    if (items.length === 0) return [];
    const outcomes = await Promise.all(
      items.map((item) =>
        run(item).then(
          (o) => o,
          () => "retry" as Outcome,
        ),
      ),
    );
    if (outcomes.every((o) => o === "done")) {
      await this.ack(name);
      return items;
    }
    await this.restore(name);
    return items;
  }

  /** Re-queue any inflight items left by a crashed prior holder. */
  async recover(name: string): Promise<void> {
    await this.restore(name);
  }

  /**
   * Recover every identity with an orphan inflight file. Returns the names
   * recovered. Generalizes `recoverOrphanInflight`.
   */
  async recoverAll(): Promise<string[]> {
    const names = await list(this.inflightBase(), this.cfg.ext);
    for (const name of names) await this.restore(name);
    return names;
  }

  /** Names with a pending file. Generalizes `listKicks`. */
  async pendingNames(): Promise<string[]> {
    return list(this.base(), this.cfg.ext);
  }

  // --- decoupled lease API: claim / ack / restore ---
  //
  // `drain` is claim → run → ack|restore in one call, for sources whose
  // processing is synchronous with the drain (kicks). The inbox needs them
  // split: claim leases targets at fire-start, then the async Deno child runs,
  // then ack (clean) or restore (failure) lands much later. Same lease, two
  // call shapes.

  /** Lease pending → inflight, read + dedup, return the claimed items. */
  async claim(name: string): Promise<T[]> {
    const file = this.pending(name);
    const lease = this.inflight(name);
    await mkdir(this.base(), { recursive: true });
    await mkdir(this.inflightBase(), { recursive: true });

    try {
      await rename(file, lease);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const items = await this.read(lease);
    if (items.length === 0) {
      await unlink(lease).catch(ignoreEnoent);
      return [];
    }
    // Rewrite the lease deduped so a later restore re-queues the collapsed
    // set, not the raw append-log.
    const tmp = `${lease}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, items.map(serialize).join(""));
    await rename(tmp, lease);
    return items;
  }

  /** Drop the lease — the claimed items are done. */
  async ack(name: string): Promise<void> {
    await unlink(this.inflight(name)).catch(ignoreEnoent);
  }

  /** Re-queue the leased items back to pending, then drop the lease. */
  async restore(name: string): Promise<void> {
    const lease = this.inflight(name);
    let raw: string;
    try {
      raw = await readFile(lease, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (raw.length > 0) await this.requeue(name, raw);
    await unlink(lease).catch(ignoreEnoent);
  }

  /** Append (log) or exclusively rewrite (latest) leased rows back to pending. */
  private async requeue(name: string, raw: string): Promise<void> {
    const file = this.pending(name);
    await mkdir(this.base(), { recursive: true });
    // `latest` shape: a fresh enqueue during the run already supersedes the
    // leased item, so restore exclusively — EEXIST means something newer is
    // pending and the lease is simply dropped. `log` shape appends back; the
    // next claim re-dedups.
    if (this.cfg.shape === "latest") return writeFile(file, raw, { flag: "wx" }).catch(ignoreEexist);
    return appendFile(file, raw);
  }

  private async read(file: string): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    if (this.cfg.shape === "latest") {
      const item = parse<T>(raw.trim());
      return item ? [item] : [];
    }
    // At-least-once: a partial-write tail row is dropped here; the producer
    // re-discovers it on its next event.
    const rows = raw.split("\n").flatMap((line) => {
      if (!line) return [];
      const item = parse<T>(line);
      return item ? [item] : [];
    });
    return this.dedup(rows);
  }

  private dedup(rows: T[]): T[] {
    if (!this.cfg.key) return rows;
    const key = this.cfg.key;
    const prefer = this.cfg.prefer;
    const kept = new Map<string, T>();
    for (const r of rows) {
      const prev = kept.get(key(r));
      // No prefer comparator → last-appended wins. With one (inbox), the
      // comparator picks the survivor (latest mtime), independent of order.
      kept.set(key(r), prev && prefer ? prefer(prev, r) : r);
    }
    return Array.from(kept.values());
  }
}

/**
 * A fire source: a thin adapter that wires a live producer to the Queue
 * (`start`) and re-derives owed work at boot (`recover`). Depth lives in the
 * Queue, never here — sources stay small and distinct (cron, chokidar, kick
 * signal all look different; only the Queue is shared).
 *
 * `emit` enqueues + (for live sources) nudges the drain. Each source decides
 * what to emit; the daemon owns the drain.
 */
export interface Source {
  /** Wire the live producer. `emit` enqueues an item for `name`. */
  start(emit: Emit): void | Promise<void>;
  /** Boot: re-derive owed work from durable state and `emit` it. */
  recover(emit: Emit): void | Promise<void>;
  /** Tear down the live producer. */
  stop(): void | Promise<void>;
}

export type Emit = (name: string) => void | Promise<void>;

function serialize(item: unknown): string {
  return `${JSON.stringify(item)}\n`;
}

function parse<T>(line: string): T | null {
  if (!line) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

async function list(dir: string, ext: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const suffix = `.${ext}`;
  return entries
    .toSorted()
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length));
}

function ignoreEnoent(err: unknown): void {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

function ignoreEexist(err: unknown): void {
  if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
}

function assertSafe(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error(`invalid queue identity: ${JSON.stringify(name)}`);
  }
}
