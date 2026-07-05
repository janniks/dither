import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildListOptions,
  formatDryRun,
  formatMissing,
  hasFieldDescription,
  humanizeSchedule,
  mergeInputs,
  planInstall,
  readExistingGrants,
} from "./plugin-install-interactive";
import type { ParsedPackage } from "./manifest";

function pkg(manifest: ParsedPackage["manifest"]): ParsedPackage {
  return { name: "p", version: "0.1.0", manifest };
}

describe("planInstall", () => {
  it("ok when no manifest declarations", async () => {
    const r = await planInstall(pkg({}), {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toEqual({
        env: {},
        envRefs: [],
        files: {},
        net: [],
        create: [],
        edit: [],
        schedule: null,
        watch: null,
      });
    }
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
      pkg({ net: ["api.example.com"], create: ["a/**"] }),
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.net).toEqual(["api.example.com"]);
      expect(r.resolved.create).toEqual(["a/**"]);
    }
  });

  it("net / collections flag overrides the manifest declaration", async () => {
    const r = await planInstall(
      pkg({ net: ["api.example.com"], create: ["a/**"] }),
      { net: ["only.example.com"], create: ["b/**"] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.net).toEqual(["only.example.com"]);
      expect(r.resolved.create).toEqual(["b/**"]);
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

describe("formatDryRun", () => {
  it("lists required fields not yet provided", async () => {
    const p = pkg({ env: [{ name: "API_TOKEN" }], files: [{ id: "db", kind: "file", required: true }] });
    const out = formatDryRun(p, await planInstall(p, {}));
    expect(out).toContain("required, not yet provided:");
    expect(out).toContain("env  API_TOKEN");
    expect(out).toContain("file  db");
  });

  it("reports satisfied when flags cover the required fields", async () => {
    const p = pkg({ env: [{ name: "API_TOKEN" }] });
    const out = formatDryRun(p, await planInstall(p, { env: { API_TOKEN: "x" } }));
    expect(out).toContain("required fields satisfied");
    expect(out).not.toContain("not yet provided");
  });

  it("surfaces optional + consent items without leaking secret values", async () => {
    const p = pkg({
      env: [{ name: "API_TOKEN" }, { name: "REGION", default: "us" }],
      net: ["api.example.com"],
      create: ["articles"],
      schedule: "0 9 * * *",
    });
    const out = formatDryRun(p, await planInstall(p, { env: { API_TOKEN: "secret" } }));
    expect(out).toContain("env REGION (default us)");
    expect(out).toContain("net api.example.com");
    expect(out).toContain("create articles");
    expect(out).toContain("schedule 0 9 * * *");
    expect(out).not.toContain("secret");
  });
});

describe("planInstall — schedule + watch resolution", () => {
  it("defaults schedule to manifest declared when input is undefined", async () => {
    const r = await planInstall(pkg({ schedule: "*/15 * * * *" }), {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.schedule).toBe("*/15 * * * *");
  });

  it("null in inputs overrides manifest declared (manual-only)", async () => {
    const r = await planInstall(pkg({ schedule: "*/15 * * * *" }), { schedule: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.schedule).toBeNull();
  });

  it("string in inputs overrides manifest (custom cron)", async () => {
    const r = await planInstall(pkg({ schedule: "*/15 * * * *" }), { schedule: "*/30 * * * *" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.schedule).toBe("*/30 * * * *");
  });

  it("schedule null when manifest has no schedule and inputs undefined", async () => {
    const r = await planInstall(pkg({}), {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.schedule).toBeNull();
  });

  it("defaults watch to manifest declared when input is undefined", async () => {
    const r = await planInstall(pkg({ watch: { collections: ["a/**"] } }), {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.watch).toEqual({ collections: ["a/**"] });
  });

  it("null in inputs overrides manifest watch (disabled)", async () => {
    const r = await planInstall(pkg({ watch: { collections: ["a/**"] } }), { watch: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.watch).toBeNull();
  });
});

describe("humanizeSchedule", () => {
  it("formats minute intervals", () => {
    expect(humanizeSchedule("*/15 * * * *")).toBe("every 15 minutes");
    expect(humanizeSchedule("*/5 * * * *")).toBe("every 5 minutes");
  });

  it("formats hourly", () => {
    expect(humanizeSchedule("0 * * * *")).toBe("every hour");
  });

  it("formats daily", () => {
    expect(humanizeSchedule("0 0 * * *")).toBe("daily");
  });

  it("accepts the shorthand syntaxes parseSchedule understands", () => {
    expect(humanizeSchedule("every 15m")).toBe("every 15 minutes");
  });

  it("falls back to the raw pattern when nothing matches", () => {
    expect(humanizeSchedule("not a cron at all")).toBe("not a cron at all");
  });
});

describe("mergeInputs — schedule + watch", () => {
  it("extra schedule wins over base when defined", () => {
    expect(mergeInputs({ schedule: "*/15 * * * *" }, { schedule: null }).schedule).toBeNull();
    expect(mergeInputs({ schedule: null }, { schedule: "*/5 * * * *" }).schedule).toBe(
      "*/5 * * * *",
    );
  });

  it("base schedule preserved when extra is undefined", () => {
    expect(mergeInputs({ schedule: "*/15 * * * *" }, {}).schedule).toBe("*/15 * * * *");
  });

  it("extra watch wins over base when defined; undefined preserves base", () => {
    expect(mergeInputs({ watch: { collections: ["a/**"] } }, { watch: null }).watch).toBeNull();
    expect(mergeInputs({ watch: null }, {}).watch).toBeNull();
  });
});

describe("hasFieldDescription", () => {
  it("false when no env or file declarations", () => {
    expect(hasFieldDescription(pkg({}))).toBe(false);
  });

  it("false when fields have no description", () => {
    expect(hasFieldDescription(pkg({ env: [{ name: "A" }] }))).toBe(false);
    expect(
      hasFieldDescription(pkg({ files: [{ id: "cfg", kind: "file" }] })),
    ).toBe(false);
  });

  it("true when an env field has a non-empty description", () => {
    expect(
      hasFieldDescription(pkg({ env: [{ name: "A", description: "the A" }] })),
    ).toBe(true);
  });

  it("true when a file field has a non-empty description", () => {
    expect(
      hasFieldDescription(
        pkg({ files: [{ id: "cfg", kind: "file", description: "the config" }] }),
      ),
    ).toBe(true);
  });

  it("false when descriptions are whitespace-only", () => {
    expect(
      hasFieldDescription(pkg({ env: [{ name: "A", description: "   " }] })),
    ).toBe(false);
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

describe("readExistingGrants", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dither-grants-"));
    prev = process.env.DITHER_DIR;
    process.env.DITHER_DIR = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DITHER_DIR;
    else process.env.DITHER_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when no grants file exists", async () => {
    expect(await readExistingGrants("nope")).toBeNull();
  });

  it("returns the previously persisted grant fields", async () => {
    mkdirSync(join(home, "grants"));
    writeFileSync(
      join(home, "grants", "p.json"),
      JSON.stringify({
        name: "p",
        env: { A: "v" },
        envRefs: ["TOKEN"],
        files: { cfg: "/tmp/c" },
        net: ["x.example.com"],
        create: ["a/**"],
      }),
    );
    const g = await readExistingGrants("p");
    expect(g).toEqual({
      env: { A: "v" },
      envRefs: ["TOKEN"],
      files: { cfg: "/tmp/c" },
      net: ["x.example.com"],
      create: ["a/**"],
      edit: undefined,
    });
  });

  it("treats a corrupt grants file as a fresh install", async () => {
    mkdirSync(join(home, "grants"));
    writeFileSync(join(home, "grants", "p.json"), "not json");
    expect(await readExistingGrants("p")).toBeNull();
  });
});

describe("planInstall with pre-fill (existing grants merged under flags)", () => {
  it("uses existing grant value when no flag passed → not missing", async () => {
    const existing = { env: { TOKEN: "from-grants" } };
    const merged = mergeInputs(existing, {});
    const r = await planInstall(pkg({ env: [{ name: "TOKEN" }] }), merged);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.env).toEqual({ TOKEN: "from-grants" });
  });

  it("flag value wins over existing grant value", async () => {
    const existing = { env: { TOKEN: "from-grants" } };
    const opts = { env: { TOKEN: "from-flag" } };
    const r = await planInstall(pkg({ env: [{ name: "TOKEN" }] }), mergeInputs(existing, opts));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.env).toEqual({ TOKEN: "from-flag" });
  });

  it("a newly-declared env not in existing grants is missing", async () => {
    const existing = { env: { OLD: "v" } };
    const r = await planInstall(
      pkg({ env: [{ name: "OLD" }, { name: "NEW_FIELD" }] }),
      mergeInputs(existing, {}),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual([{ kind: "env", name: "NEW_FIELD" }]);
  });
});

describe("buildListOptions", () => {
  it("fresh install: every manifest entry pre-checked, no hints", () => {
    expect(buildListOptions(undefined, ["a", "b"])).toEqual([
      { value: "a", initial: true },
      { value: "b", initial: true },
    ]);
  });

  it("reinstall unchanged: every entry pre-checked, no hints", () => {
    expect(buildListOptions(["a", "b"], ["a", "b"])).toEqual([
      { value: "a", initial: true },
      { value: "b", initial: true },
    ]);
  });

  it("reinstall + manifest widened: new entry unchecked with (new)", () => {
    expect(buildListOptions(["a"], ["a", "b"])).toEqual([
      { value: "a", initial: true },
      { value: "b", initial: false, hint: "(new)" },
    ]);
  });

  it("reinstall + manifest narrowed: dropped entry pre-checked with hint", () => {
    expect(buildListOptions(["a", "b"], ["a"])).toEqual([
      { value: "a", initial: true },
      { value: "b", initial: true, hint: "(plugin no longer requests)" },
    ]);
  });

  it("manifest order preserved, prior-only entries appended", () => {
    expect(buildListOptions(["x", "a"], ["a", "b"])).toEqual([
      { value: "a", initial: true },
      { value: "b", initial: false, hint: "(new)" },
      { value: "x", initial: true, hint: "(plugin no longer requests)" },
    ]);
  });

  it("empty prior + empty manifest: empty list", () => {
    expect(buildListOptions([], [])).toEqual([]);
    expect(buildListOptions(undefined, undefined)).toEqual([]);
  });

  it("prior empty array (reinstall with nothing granted) treats every manifest entry as (new)", () => {
    // hasPrior=true (empty array IS a prior decision), so new entries get (new).
    expect(buildListOptions([], ["a"])).toEqual([
      { value: "a", initial: false, hint: "(new)" },
    ]);
  });
});
