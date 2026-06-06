import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStamp, stampString, buildVersion, readBuildInfo, isStale } from "./build-stamp";

const pkgVersion = "0.0.1"; // single source: packages/cli/package.json

describe("build-stamp accessor", () => {
  // Under vitest the bundle isn't built, so __BUILD_STAMP__ is undefined and
  // the fallback path runs — it must not throw and must yield the pkg version.
  it("returns a structured stamp via the dev/test fallback without throwing", () => {
    const stamp = buildStamp();
    expect(stamp).toMatchObject({ version: pkgVersion, sha: "dev", builtAt: "" });
    expect(buildVersion()).toBe(pkgVersion);
  });

  it("stampString is bare version when sha/builtAt are empty (prod shape)", () => {
    expect(stampString({ version: "0.0.1", sha: "", builtAt: "" })).toBe("0.0.1");
  });

  it("stampString appends +sha.builtAt for a dev stamp", () => {
    expect(stampString({ version: "0.0.1", sha: "abc1234", builtAt: "20260101000000" })).toBe(
      "0.0.1+abc1234.20260101000000",
    );
  });
});

describe("readBuildInfo", () => {
  it("round-trips a written dist/build-info.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-buildinfo-"));
    const path = join(dir, "build-info.json");
    const stamp = { version: "1.2.3", sha: "deadbee", builtAt: "20260102030405" };
    writeFileSync(path, JSON.stringify(stamp));
    expect(await readBuildInfo(path)).toEqual(stamp);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null on ENOENT", async () => {
    expect(await readBuildInfo(join(tmpdir(), "no-such-build-info.json"))).toBeNull();
  });
});

describe("isStale", () => {
  // Baked stamp under vitest is the dev fallback: { version: pkgVersion, sha:
  // "dev", builtAt: "" }. A sidecar that differs from that → stale.
  it("true when the disk sidecar differs from the baked/dev stamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-stale-"));
    const path = join(dir, "build-info.json");
    writeFileSync(path, JSON.stringify({ version: "9.9.9", sha: "feedbee", builtAt: "20260606000000" }));
    expect(await isStale(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("false when the disk sidecar matches the baked/dev stamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dither-stale-"));
    const path = join(dir, "build-info.json");
    writeFileSync(path, JSON.stringify(buildStamp()));
    expect(await isStale(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("false when the sidecar is missing (nothing to compare)", async () => {
    expect(await isStale(join(tmpdir(), "no-such-build-info.json"))).toBe(false);
  });
});
