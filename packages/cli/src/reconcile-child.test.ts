import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReconcileChild } from "./daemon-jobs";
import { readGlobal } from "./run-log";
import { needsReindexPath, requestReindexSync } from "./markers";
import { existsSync } from "node:fs";
import { writeTestConfig } from "../test/helpers/config";

/**
 * Standalone Phase-1 coverage for the child entrypoint. Exercises the real
 * qmd index path against a temp library — no mocks, real openStore +
 * store.update.
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

    const summary = await runReconcileChild();
    expect(summary.jobsRun).toBe(1);
    // Marker consumed by the index job.
    expect(existsSync(needsReindexPath())).toBe(false);

    const events = await readGlobal();
    expect(events[0]?.kind).toBe("reconcile-started");
    expect(events.some((e) => e.kind === "job-done" && e.type === "indexing")).toBe(true);
    const done = events.find((e) => e.kind === "job-done" && e.type === "indexing");
    expect(done?.filesIndexed).toBe(1);
    expect(events[events.length - 1]?.kind).toBe("reconcile-done");
  });

  it("sets process.title so the worker is legible in ps", async () => {
    await runReconcileChild();
    expect(process.title).toBe("dither daemon reconcile");
  });

  it("exits clean with no jobs when the library has no collections", async () => {
    // library/ exists but has no subdir collections after we remove notes.
    rmSync(join(library, "notes"), { recursive: true, force: true });

    const summary = await runReconcileChild();
    expect(summary.jobsRun).toBe(0);
    const events = await readGlobal();
    expect(events[events.length - 1]?.kind).toBe("reconcile-done");
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
