import { mkdir, readFile, writeFile, readdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveHome } from "./home";
import { parsePackage } from "./manifest";
import { updateIndex } from "./update-index";

export interface RunOptions {
  name: string;
  trigger?: "scheduled" | "watch" | "manual";
}

export interface RunResult {
  runId: string;
  promoted: string[];
}

const DITHER_ENV_VARS = [
  "DITHER_RUN_DIR",
  "DITHER_INPUT_FILE",
  "DITHER_STATE_FILE",
  "DITHER_TRIGGER",
  "DITHER_PLUGIN_NAME",
];

function extractCollection(content: string): string | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const lines = m[1]!.split("\n");
  for (const line of lines) {
    const kv = line.match(/^collection:\s*"?([^"\n]+)"?\s*$/);
    if (kv) return kv[1]!.trim().replace(/^"|"$/g, "");
  }
  return null;
}

function extractSource(content: string): string | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^source:\s*"?([^"\n]+)"?\s*$/);
    if (kv) return kv[1]!.trim().replace(/^"|"$/g, "");
  }
  return null;
}

export async function runPlugin(opts: RunOptions): Promise<RunResult> {
  const home = resolveHome();
  const pluginDir = join(home, "plugins", opts.name);
  if (!existsSync(pluginDir)) {
    throw new Error(`Plugin not installed: ${opts.name}`);
  }

  const pkgRaw = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf-8")) as unknown;
  const parsed = parsePackage(pkgRaw);
  const allowedCollections = new Set(parsed.manifest.collections?.writes ?? []);

  // Load grants written at install time. Splits inputs by manifest kind:
  // `secret` → input.json.secrets, others → input.json.config. File paths
  // pass through unchanged into input.json.files and become extra
  // --allow-read entries on the Deno spawn.
  const grantsPath = join(home, "grants", `${opts.name}.json`);
  const grantsRaw = existsSync(grantsPath)
    ? (JSON.parse(await readFile(grantsPath, "utf-8")) as {
        inputs?: Record<string, unknown>;
        files?: Record<string, string>;
      })
    : { inputs: {}, files: {} };
  const grantInputs = grantsRaw.inputs ?? {};
  const grantFiles = grantsRaw.files ?? {};

  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const def of parsed.manifest.inputs ?? []) {
    const value = grantInputs[def.id];
    if (value === undefined) continue;
    if (def.kind === "secret") {
      secrets[def.id] = String(value);
    } else {
      config[def.id] = value;
    }
  }

  const runId = randomUUID();
  const runDir = join(home, "runs", runId);
  await mkdir(runDir, { recursive: true });

  const stateDir = join(pluginDir, "state");
  await mkdir(stateDir, { recursive: true });
  const stateFile = join(stateDir, "state.json");

  const inputFile = join(runDir, "input.json");
  const trigger = opts.trigger ?? "manual";
  await writeFile(
    inputFile,
    JSON.stringify(
      {
        trigger,
        config,
        secrets,
        files: grantFiles,
        targets: [],
      },
      null,
      2,
    ),
  );

  // Resolve the SDK path so we can build a Deno import map.
  const sdkUrl = import.meta.resolve("@dither/plugin");
  const sdkPath = fileURLToPath(sdkUrl);
  const importMapPath = join(runDir, "_import-map.json");
  await writeFile(
    importMapPath,
    JSON.stringify({
      imports: { "@dither/plugin": sdkUrl },
    }),
  );

  const allowRead = [pluginDir, runDir, sdkPath, ...Object.values(grantFiles)].join(",");
  const allowWrite = [stateDir, runDir].join(",");
  const allowEnv = [...DITHER_ENV_VARS, ...(parsed.manifest.permissions?.host_env ?? [])].join(",");

  const denoArgs = [
    "run",
    `--import-map=${importMapPath}`,
    `--allow-read=${allowRead}`,
    `--allow-write=${allowWrite}`,
    `--allow-env=${allowEnv}`,
  ];
  const hostNet = parsed.manifest.permissions?.host_net ?? [];
  if (hostNet.length) {
    denoArgs.push(`--allow-net=${hostNet.join(",")}`);
  }
  denoArgs.push(join(pluginDir, "plugin.ts"));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DITHER_RUN_DIR: runDir,
    DITHER_INPUT_FILE: inputFile,
    DITHER_STATE_FILE: stateFile,
    DITHER_TRIGGER: trigger,
    DITHER_PLUGIN_NAME: opts.name,
  };

  await new Promise<void>((res, rej) => {
    const child = spawn("deno", denoArgs, { env, stdio: "inherit" });
    child.on("error", rej);
    child.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`plugin '${opts.name}' exited with code ${code}`));
    });
  });

  // Promote any *.md files the plugin wrote.
  const entries = await readdir(runDir);
  const promoted: string[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const src = join(runDir, file);
    const content = await readFile(src, "utf-8");

    const source = extractSource(content);
    if (source !== opts.name) {
      throw new Error(
        `output ${file} declares source=${source ?? "(missing)"}; expected ${opts.name}`,
      );
    }
    const collection = extractCollection(content);
    if (!collection) {
      throw new Error(`output ${file} missing 'collection' frontmatter`);
    }
    if (!allowedCollections.has(collection)) {
      throw new Error(
        `plugin '${opts.name}' is not granted write access to collection '${collection}'`,
      );
    }

    const destDir = join(home, "entries", collection);
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, file);
    await copyFile(src, dest);
    promoted.push(dest);
  }

  await rm(runDir, { recursive: true, force: true });

  // Refresh the qmd index so newly-promoted entries are searchable
  // immediately. Skipped when nothing was written — saves a no-op pass.
  if (promoted.length > 0) {
    await updateIndex();
  }

  return { runId, promoted };
}
