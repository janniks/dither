import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReconcileChild } from "./reconcile-run";
import { parseReconcile } from "./reconcile-protocol";
import { readGlobal } from "./run-log";
import { needsReindexPath, requestReindexSync } from "./markers";
import { existsSync, readFileSync } from "node:fs";
import { themeLockPath } from "./locks";
import { writeTestConfig } from "../test/helpers/config";

/**
 * Standalone coverage for the child entrypoint. Exercises the real qmd
 * index path against a temp library — no mocks, real openStore +
 * store.update. Since Phase 2 the child reports via the stderr NDJSON sink
 * (no journal writes), so we capture emitted lines instead of readGlobal.
 *
 * Embedding is deliberately NOT asserted here: the first store.embed()
 * triggers qmd's ~333MB model download, which we must not pull into the
 * default test run. No existing test exercises real embedding without that
 * download (cf. command-index.test.ts, which only indexes), so we mirror
 * that precedent and cover index + the clean no-work / no-library exits.
 */
describe("runReconcileChild", () => {
  let home: string;
  let prev: string | undefined;
  let library: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dither-reconcile-child-test-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
    library = join(home, "library");
    mkdirSync(join(library, "notes"), { recursive: true });
    await writeTestConfig(library);
    // Hard gate: indexing produces chunks that need embedding, and the
    // embed path would pull qmd's ~333MB model download on first use. We
    // never exercise real embedding in the default test run (no existing
    // test does either — cf. command-index.test.ts only indexes). Disable
    // embed for every case so reconcile stops after the index phase.
    const { disableEmbed } = await import("./markers");
    disableEmbed();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("indexes a real library on a reindex marker and emits reconcile bookends + an indexing job", async () => {
    writeFileSync(join(library, "notes", "memo.md"), "# Memo\n\nHello world.\n", "utf-8");
    // A fresh store reports collections=[] until the first index, so the
    // reconcile's first-pass guard (collections.length > 0) is false. The
    // real trigger for a never-indexed library is the needs-reindex marker
    // that `init`/promotion write — claimReindex() consumes it and runs
    // runIndexJob. This is the production index path.
    requestReindexSync();

    const lines: string[] = [];
    const summary = await runReconcileChild((l) => lines.push(l));
    expect(summary.jobsRun).toBe(1);
    // Marker consumed by the index job.
    expect(existsSync(needsReindexPath())).toBe(false);

    // Child reports via NDJSON, not the journal (daemon owns that in P3).
    const msgs = lines.map(parseReconcile);
    expect(msgs.some((m) => m?.kind === "job-done" && m.type === "indexing")).toBe(true);
    const done = msgs.find((m) => m?.kind === "job-done" && m.type === "indexing");
    expect(done && "filesIndexed" in done ? done.filesIndexed : null).toBe(1);
    expect(msgs[msgs.length - 1]?.kind).toBe("reconcile-done");
    // No journal writes on the child path.
    expect(await readGlobal()).toEqual([]);
  });

  it("holds the index theme lock with the reconcile process's own PID", async () => {
    writeFileSync(join(library, "notes", "memo.md"), "# Memo\n\nHello world.\n", "utf-8");
    requestReindexSync();

    // The lock is acquired+released entirely inside runReconcileChild, so we
    // observe it mid-run: on the first indexing job-progress line the lock is
    // held, and its body must be THIS process's pid (Phase 4: holder PID ==
    // the worker doing the qmd write, not a separate daemon). Post-P3 the
    // worker IS this process when runReconcileChild runs in-band.
    let holder: number | null = null;
    await runReconcileChild((line) => {
      const msg = parseReconcile(line);
      if (msg?.kind === "job-progress" && msg.type === "indexing" && holder === null) {
        holder = Number.parseInt(readFileSync(themeLockPath("index"), "utf-8").trim(), 10);
      }
    });

    expect(holder).toBe(process.pid);
    // Released after the job — no stale lock file left behind.
    expect(existsSync(themeLockPath("index"))).toBe(false);
  });

  it("sets process.title so the worker is legible in ps", async () => {
    await runReconcileChild();
    expect(process.title).toBe("dither daemon reconcile");
  });

  it("with embed-disabled marker set (dither index cancel), the child indexes but skips embedding and leaves no embed lock", async () => {
    // `dither index cancel` writes the embed-disabled marker (set in
    // beforeEach for every case here). The child's reconcile checks
    // readMarkerState().embedDisabled before the embed leg and between
    // embedLoop iterations, so it never enters embedding — no `embedding`
    // job-started, no model-download, and crucially no `qmd-embed.lock`
    // stranded. We exercise the index leg (real qmd) and assert the embed
    // path is fully skipped (cancellation path; avoids the ~333MB download).
    writeFileSync(join(library, "notes", "memo.md"), "# Memo\n\nHello world.\n", "utf-8");
    requestReindexSync();

    const lines: string[] = [];
    await runReconcileChild((l) => lines.push(l));
    const msgs = lines.map(parseReconcile);

    // Index ran...
    expect(msgs.some((m) => m?.kind === "job-done" && m.type === "indexing")).toBe(true);
    // ...but embedding never started, and no model-download bracket opened.
    expect(msgs.some((m) => m !== null && "type" in m && m.type === "embedding")).toBe(false);
    expect(msgs.some((m) => m !== null && "type" in m && m.type === "model-download")).toBe(false);
    // No stranded embed lock — runJobWithLock never acquired it.
    expect(existsSync(themeLockPath("embed"))).toBe(false);
    // Cycle still completes cleanly.
    expect(msgs[msgs.length - 1]?.kind).toBe("reconcile-done");
  });

  it("exits clean with no jobs when the library has no collections", async () => {
    // library/ exists but has no subdir collections after we remove notes.
    rmSync(join(library, "notes"), { recursive: true, force: true });

    const lines: string[] = [];
    const summary = await runReconcileChild((l) => lines.push(l));
    expect(summary.jobsRun).toBe(0);
    const msgs = lines.map(parseReconcile);
    expect(msgs[msgs.length - 1]?.kind).toBe("reconcile-done");
    expect(await readGlobal()).toEqual([]);
  });

  it("exits clean (no index job) when an indexed library has no new files", async () => {
    writeFileSync(join(library, "notes", "memo.md"), "# Memo\n\nHello.\n", "utf-8");
    // First reconcile indexes the file (via marker). Embed is disabled in
    // beforeEach, so reconcile stops after indexing.
    requestReindexSync();
    await runReconcileChild();
    // Second reconcile: nothing changed, no reindex marker → no index job.
    const summary = await runReconcileChild();
    expect(summary.jobsRun).toBe(0);
  });
});
