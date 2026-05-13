import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMissing, mergeInputs, planInstall } from "./plugin-install-interactive";
import type { ParsedPackage } from "./manifest";

function pkg(manifest: ParsedPackage["manifest"]): ParsedPackage {
  return { name: "p", version: "0.1.0", manifest };
}

describe("planInstall", () => {
  it("ok when no manifest declarations", async () => {
    const r = await planInstall(pkg({}), {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toEqual({ env: {}, envRefs: [], files: {}, net: [], collections: [] });
  });

  it("collects every missing required env in one pass", async () => {
    const r = await planInstall(
      pkg({ env: [{ name: "A" }, { name: "B" }, { name: "HAS_DEFAULT", default: "x" }] }),
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual([
        { kind: "env", name: "A" },
        { kind: "env", name: "B" },
      ]);
      expect(r.partial.env).toEqual({ HAS_DEFAULT: "x" });
    }
  });

  it("collects missing required files alongside missing envs", async () => {
    const r = await planInstall(
      pkg({
        env: [{ name: "TOKEN" }],
        files: [
          { id: "cfg", kind: "file", required: true },
          { id: "opt", kind: "file" },
        ],
      }),
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual([
        { kind: "env", name: "TOKEN" },
        { kind: "file", name: "cfg" },
      ]);
    }
  });

  it("counts env satisfied by --allow-env as not missing", async () => {
    const r = await planInstall(pkg({ env: [{ name: "OPENAI_API_KEY" }] }), {
      envRefs: ["OPENAI_API_KEY"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.envRefs).toEqual(["OPENAI_API_KEY"]);
      expect(r.resolved.env).toEqual({});
    }
  });

  it("counts env satisfied by literal --env value as not missing", async () => {
    const r = await planInstall(pkg({ env: [{ name: "MODEL" }] }), { env: { MODEL: "gpt-4" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.env).toEqual({ MODEL: "gpt-4" });
  });

  it("resolves provided file path to its realpath", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plan-install-"));
    try {
      const cfg = join(tmp, "config.json");
      writeFileSync(cfg, "{}");
      const r = await planInstall(pkg({ files: [{ id: "cfg", kind: "file", required: true }] }), {
        files: { cfg },
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.resolved.files.cfg).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("net / collections fall back to manifest declarations when no flag passed", async () => {
    const r = await planInstall(
      pkg({ net: ["api.example.com"], collections: ["a/**"] }),
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.net).toEqual(["api.example.com"]);
      expect(r.resolved.collections).toEqual(["a/**"]);
    }
  });

  it("net / collections flag overrides the manifest declaration", async () => {
    const r = await planInstall(
      pkg({ net: ["api.example.com"], collections: ["a/**"] }),
      { net: ["only.example.com"], collections: ["b/**"] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.net).toEqual(["only.example.com"]);
      expect(r.resolved.collections).toEqual(["b/**"]);
    }
  });

  it("rejects a non-existent file path with a clear error", async () => {
    await expect(
      planInstall(pkg({ files: [{ id: "cfg", kind: "file", required: true }] }), {
        files: { cfg: "/nope/does/not/exist" },
      }),
    ).rejects.toThrow(/path does not exist/);
  });

  it("rejects when file id requires a folder but path is a file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plan-install-"));
    try {
      const f = join(tmp, "f");
      writeFileSync(f, "x");
      await expect(
        planInstall(pkg({ files: [{ id: "dir", kind: "folder", required: true }] }), {
          files: { dir: f },
        }),
      ).rejects.toThrow(/must be a folder/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("optional file with no value is silently skipped", async () => {
    const r = await planInstall(pkg({ files: [{ id: "opt", kind: "file" }] }), {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.files).toEqual({});
  });
});

describe("formatMissing", () => {
  it("groups env and file fields", () => {
    expect(
      formatMissing([
        { kind: "env", name: "A" },
        { kind: "env", name: "B" },
        { kind: "file", name: "cfg" },
      ]),
    ).toMatch(/env: A, B; file: cfg/);
  });

  it("omits empty groups", () => {
    expect(formatMissing([{ kind: "env", name: "A" }])).toMatch(/env: A\b/);
    expect(formatMissing([{ kind: "env", name: "A" }])).not.toMatch(/file:/);
  });
});

describe("mergeInputs", () => {
  it("overlays env literals and dedupes allow-env refs", () => {
    const merged = mergeInputs(
      { env: { A: "from-flag" }, envRefs: ["X"] },
      { env: { B: "from-prompt" }, envRefs: ["X", "Y"] },
    );
    expect(merged.env).toEqual({ A: "from-flag", B: "from-prompt" });
    expect(merged.envRefs).toEqual(["X", "Y"]);
  });

  it("prompt-supplied file paths win over flag-supplied", () => {
    const merged = mergeInputs(
      { files: { cfg: "/from/flag" } },
      { files: { cfg: "/from/prompt" } },
    );
    expect(merged.files).toEqual({ cfg: "/from/prompt" });
  });
});
