import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("markers", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-markers-test-"));
    prevHome = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.DITHER_DIR;
    } else {
      process.env.DITHER_DIR = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("paths point under <home>/markers/", async () => {
    const { needsReindexPath, embedDisabledPath } = await import("./markers");
    expect(needsReindexPath()).toBe(join(home, "markers", "needs-reindex"));
    expect(embedDisabledPath()).toBe(join(home, "markers", "embed-disabled"));
  });

  it("requestReindex / clearReindex round-trip", async () => {
    const { requestReindex, clearReindex, needsReindexPath } = await import("./markers");
    await requestReindex();
    expect(existsSync(needsReindexPath())).toBe(true);
    clearReindex();
    expect(existsSync(needsReindexPath())).toBe(false);
    // Idempotent — clearing twice is a no-op.
    clearReindex();
  });

  it("requestReindexSync writes the marker", async () => {
    const { requestReindexSync, needsReindexPath } = await import("./markers");
    requestReindexSync();
    expect(existsSync(needsReindexPath())).toBe(true);
  });

  it("disableEmbed / enableEmbed round-trip", async () => {
    const { disableEmbed, enableEmbed, embedDisabledPath } = await import("./markers");
    disableEmbed();
    expect(existsSync(embedDisabledPath())).toBe(true);
    enableEmbed();
    expect(existsSync(embedDisabledPath())).toBe(false);
    // Idempotent.
    enableEmbed();
  });

  it("readMarkerState reflects on-disk presence", async () => {
    const { readMarkerState, requestReindexSync, disableEmbed, clearReindex } = await import(
      "./markers"
    );
    expect(readMarkerState()).toEqual({ needsReindex: false, embedDisabled: false });
    requestReindexSync();
    expect(readMarkerState()).toEqual({ needsReindex: true, embedDisabled: false });
    disableEmbed();
    expect(readMarkerState()).toEqual({ needsReindex: true, embedDisabled: true });
    clearReindex();
    expect(readMarkerState()).toEqual({ needsReindex: false, embedDisabled: true });
  });

  it("claimReindex moves the marker aside; releaseReindexClaim removes it", async () => {
    const { requestReindexSync, claimReindex, releaseReindexClaim, needsReindexPath } =
      await import("./markers");
    requestReindexSync();
    expect(claimReindex()).toBe(true);
    expect(existsSync(needsReindexPath())).toBe(false);
    expect(existsSync(`${needsReindexPath()}.processing`)).toBe(true);
    // A fresh write during processing lands on a clean marker.
    requestReindexSync();
    expect(existsSync(needsReindexPath())).toBe(true);
    releaseReindexClaim();
    expect(existsSync(`${needsReindexPath()}.processing`)).toBe(false);
    expect(existsSync(needsReindexPath())).toBe(true);
  });

  it("claimReindex returns false when no marker exists", async () => {
    const { claimReindex } = await import("./markers");
    expect(claimReindex()).toBe(false);
  });

  describe("auto-migration", () => {
    it("moves legacy top-level needs-reindex into markers/", async () => {
      // Plant the legacy file before any marker code touches the home.
      writeFileSync(join(home, "needs-reindex"), "");
      const { _resetMarkersMigrationLatch, readMarkerState } = await import("./markers");
      _resetMarkersMigrationLatch();
      expect(readMarkerState()).toEqual({ needsReindex: true, embedDisabled: false });
      expect(existsSync(join(home, "needs-reindex"))).toBe(false);
      expect(existsSync(join(home, "markers", "needs-reindex"))).toBe(true);
    });

    it("moves legacy top-level embed-disabled into markers/", async () => {
      writeFileSync(join(home, "embed-disabled"), "");
      const { _resetMarkersMigrationLatch, readMarkerState } = await import("./markers");
      _resetMarkersMigrationLatch();
      expect(readMarkerState()).toEqual({ needsReindex: false, embedDisabled: true });
      expect(existsSync(join(home, "embed-disabled"))).toBe(false);
      expect(existsSync(join(home, "markers", "embed-disabled"))).toBe(true);
    });

    it("when both legacy and new exist, keeps new and removes legacy", async () => {
      mkdirSync(join(home, "markers"), { recursive: true });
      writeFileSync(join(home, "markers", "needs-reindex"), "new");
      writeFileSync(join(home, "needs-reindex"), "legacy");
      const { _resetMarkersMigrationLatch, readMarkerState } = await import("./markers");
      _resetMarkersMigrationLatch();
      expect(readMarkerState().needsReindex).toBe(true);
      expect(existsSync(join(home, "needs-reindex"))).toBe(false);
      expect(existsSync(join(home, "markers", "needs-reindex"))).toBe(true);
    });

    it("is idempotent — running migration twice does nothing", async () => {
      writeFileSync(join(home, "needs-reindex"), "");
      const { _resetMarkersMigrationLatch, readMarkerState } = await import("./markers");
      _resetMarkersMigrationLatch();
      readMarkerState();
      _resetMarkersMigrationLatch();
      const state = readMarkerState();
      expect(state.needsReindex).toBe(true);
    });
  });
});
