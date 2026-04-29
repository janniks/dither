import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  outDir: "dist",
  clean: true,
  target: "node22",
  shims: false,
});
