import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("release manifest", () => {
  it("declares the plugin SDK used at runtime", async () => {
    const pkg = JSON.parse(
      await readFile(resolve(__dirname, "..", "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };

    expect(pkg.dependencies?.["@dither/plugin"]).toBe("0.0.1");
  });
});
