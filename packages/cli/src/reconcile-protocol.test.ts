import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReconcileChild } from "./reconcile-run";
import { parseReconcile } from "./reconcile-protocol";
import { disableEmbed, requestReindexSync } from "./markers";
import { readGlobal } from "./run-log";
import { writeTestConfig } from "../test/helpers/config";

/**
 * Phase-2 coverage for the child stderr path: runReconcileChild streams
 * `_dither` NDJSON via the stderr sink and writes NO journal/`jobs/`. We
 * capture the emitted lines (injected emit, no spawn), parse them with the
 * shared protocol parser, and prove the index lifecycle + reconcile bookend
 * land on the wire. Real qmd index; embed gated off via the embed-disabled
 * marker to avoid the ~333MB model download (cf. reconcile-child.test.ts).
 */
describe("runReconcileChild stderr sink", () => {
  let home: string;
  let prev: string | undefined;
  let library: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-reconcile-proto-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    library = join(home, "library");
    mkdirSync(join(library, "notes"), { recursive: true });
    await writeTestConfig(library);
    disableEmbed();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("emits indexing job-started/progress/done + reconcile-done as NDJSON", async () => {
    writeFileSync(join(library, "notes", "memo.md"), "# Memo\n\nHello world.\n", "utf-8");
    requestReindexSync();

    const lines: string[] = [];
    const summary = await runReconcileChild((line) => lines.push(line));
    expect(summary.jobsRun).toBe(1);

    const msgs = lines.map(parseReconcile);
    // Every captured line is a valid `_dither` message (no stray journal).
    expect(msgs.every((m) => m !== null)).toBe(true);

    const started = msgs.find((m) => m?.kind === "job-started" && m.type === "indexing");
    expect(started).toBeTruthy();
    expect(started).toMatchObject({ kind: "job-started", type: "indexing" });

    const done = msgs.find((m) => m?.kind === "job-done" && m.type === "indexing");
    expect(done).toMatchObject({ kind: "job-done", type: "indexing", filesIndexed: 1 });

    const last = msgs[msgs.length - 1];
    expect(last).toMatchObject({ kind: "reconcile-done", jobsRun: 1 });

    // Child path writes NO journal and NO jobs/ — daemon owns those (P3).
    const events = await readGlobal();
    expect(events).toEqual([]);
    expect(existsSync(join(home, "jobs"))).toBe(false);

    // reconcile-started is a no-op on the child sink (daemon emits the
    // bookend at spawn time), so it never reaches the wire.
    expect(msgs.some((m) => m?.kind === "job-started" && m.type === "indexing")).toBe(true);
    expect(lines.some((l) => l.includes("reconcile-started"))).toBe(false);
  });

  it("parseReconcile ignores non-_dither diagnostic lines", () => {
    expect(parseReconcile("plain stderr noise")).toBeNull();
    expect(parseReconcile('{"foo":1}')).toBeNull();
    expect(parseReconcile("")).toBeNull();
  });
});
