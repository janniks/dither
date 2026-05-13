import { describe, it, expect } from "vitest";
import { resolveWatchPath } from "./watch-paths";

describe("resolveWatchPath", () => {
  const root = "/lib";

  const cases: Array<[string, string, string]> = [
    ["bare collection name", "github", "/lib/github"],
    ["collection subfolder", "github/repositories", "/lib/github/repositories"],
    ["explicit library-relative", "./foo", "/lib/foo"],
    ["explicit library-relative nested", "./foo/bar", "/lib/foo/bar"],
    ["absolute path", "/abs/path", "/abs/path"],
    ["absolute path stays absolute", "/var/log", "/var/log"],
  ];

  for (const [label, input, expected] of cases) {
    it(label, () => {
      expect(resolveWatchPath(root, input)).toBe(expected);
    });
  }
});
