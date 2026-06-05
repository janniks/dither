import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig } from "tsdown";

// Build stamp, computed ONCE here so the baked constant (__BUILD_STAMP__) and
// the sidecar (dist/build-info.json) can never disagree. SemVer-compatible:
// bare `version` in prod (no git → no sha), `version+<sha>.<builtAt>` in dev.
const root = dirname(fileURLToPath(import.meta.url));

function shortSha() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version as string;
const sha = shortSha();
// Digits only — colons are illegal in SemVer build metadata.
const builtAt = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const stamp = { version, sha, builtAt };

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  outDir: "dist",
  clean: true,
  target: "node22",
  shims: false,
  define: {
    __BUILD_STAMP__: JSON.stringify(JSON.stringify(stamp)),
  },
  hooks: {
    // Write the sidecar LAST and atomically (tmp + rename). Its presence with
    // a fresh stamp also signals "build complete" for the staleness check.
    "build:done": async () => {
      const dist = join(root, "dist");
      await mkdir(dist, { recursive: true });
      const tmp = join(dist, `build-info.json.${process.pid}.tmp`);
      await writeFile(tmp, JSON.stringify(stamp, null, 2));
      await rename(tmp, join(dist, "build-info.json"));
    },
  },
});
