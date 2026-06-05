import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Asserts the artifact produced by `npm run -w packages/cli build`. Skipped if
// no build has run yet (dist absent) so a clean checkout's test pass is green.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sidecar = join(root, "dist", "build-info.json");
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;

describe.skipIf(!existsSync(sidecar))("dist/build-info.json (real build)", () => {
  it("is valid JSON with the package version and a digits-only builtAt", () => {
    const stamp = JSON.parse(readFileSync(sidecar, "utf-8"));
    expect(stamp.version).toBe(pkgVersion);
    expect(typeof stamp.sha).toBe("string");
    expect(stamp.builtAt).toMatch(/^\d*$/);
  });
});
