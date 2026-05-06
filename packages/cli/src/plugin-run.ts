import { mkdir, readFile, writeFile, readdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveHome } from "./home";
import { parsePackage } from "./manifest";
import { updateIndex } from "./update-index";
import { getGlobalEnv } from "./global-env";

export interface ProgressMessage {
  message: string;
  done?: number;
  total?: number;
}

export interface RunOptions {
  name: string;
  trigger?: "scheduled" | "watch" | "manual";
  /** Per-run env literal overrides. Layered on top of grants for this run only. */
  env?: Record<string, string>;
  /** Per-run env-grant additions. Layered on top of grants for this run only. */
  envRefs?: string[];
  /** Per-run file overrides. Each path is added to --allow-read. */
  files?: Record<string, string>;
  /** Per-run net additions. Layered on top of grants for this run only. */
  net?: string[];
  /** Per-run collection grant additions. */
  collections?: string[];
  /** Called for every `progress()` NDJSON message the plugin emits on stderr. */
  onProgress?: (msg: ProgressMessage) => void;
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

interface GrantsFile {
  env?: Record<string, string>;
  envRefs?: string[];
  files?: Record<string, string>;
  net?: string[];
  collections?: string[];
}

function extractField(content: string, key: string): string | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`));
    if (kv) return kv[1]!.trim().replace(/^"|"$/g, "");
  }
  return null;
}

function parseControl(line: string): ProgressMessage | null {
  if (!line || line[0] !== "{") return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj._dither !== "progress") return null;
    if (typeof obj.message !== "string") return null;
    return {
      message: obj.message,
      done: typeof obj.done === "number" ? obj.done : undefined,
      total: typeof obj.total === "number" ? obj.total : undefined,
    };
  } catch {
    return null;
  }
}

export async function runPlugin(opts: RunOptions): Promise<RunResult> {
  const home = resolveHome();
  const pluginDir = join(home, "plugins", opts.name);
  if (!existsSync(pluginDir)) {
    throw new Error(`Plugin not installed: ${opts.name}`);
  }

  const pkgRaw = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf-8")) as unknown;
  const parsed = parsePackage(pkgRaw);

  const grantsPath = join(home, "grants", `${opts.name}.json`);
  const grants: GrantsFile = existsSync(grantsPath)
    ? (JSON.parse(await readFile(grantsPath, "utf-8")) as GrantsFile)
    : {};

  // Layer per-run overrides on top of grants. Per-run additions are ephemeral —
  // they don't get written back to the grants file.
  const grantEnv = { ...grants.env, ...opts.env };
  const envRefs = Array.from(new Set([...(grants.envRefs ?? []), ...(opts.envRefs ?? [])]));
  const grantFiles = { ...grants.files, ...opts.files };
  const grantNet = Array.from(new Set([...(grants.net ?? []), ...(opts.net ?? [])]));
  const grantCollections = Array.from(
    new Set([...(grants.collections ?? []), ...(opts.collections ?? [])]),
  );
  const allowedCollections = new Set(grantCollections);

  // Resolve the env values plugins will see: literals win; refs pull from
  // global env; manifest defaults fill the rest.
  const resolvedEnv: Record<string, string> = { ...grantEnv };
  for (const name of envRefs) {
    if (resolvedEnv[name] !== undefined) continue;
    const globalValue = await getGlobalEnv(name);
    if (globalValue !== undefined) resolvedEnv[name] = globalValue;
  }
  for (const def of parsed.manifest.env ?? []) {
    if (resolvedEnv[def.name] !== undefined) continue;
    if (def.default !== undefined) resolvedEnv[def.name] = def.default;
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
        env: resolvedEnv,
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
  const allowEnv = DITHER_ENV_VARS.join(",");

  const denoArgs = [
    "run",
    `--import-map=${importMapPath}`,
    `--allow-read=${allowRead}`,
    `--allow-write=${allowWrite}`,
    `--allow-env=${allowEnv}`,
  ];
  if (grantNet.length) {
    denoArgs.push(`--allow-net=${grantNet.join(",")}`);
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
    // stdout is inherited so user `console.log` flows straight through.
    // stderr is piped so we can parse `_dither` control messages (progress)
    // out of the stream; everything else is forwarded to host stderr.
    const child = spawn("deno", denoArgs, {
      env,
      stdio: ["inherit", "inherit", "pipe"],
    });
    let buf = "";
    child.stderr!.setEncoding("utf-8");
    child.stderr!.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = parseControl(line);
        if (msg && opts.onProgress) {
          opts.onProgress(msg);
        } else {
          process.stderr.write(`${line}\n`);
        }
      }
    });
    child.stderr!.on("end", () => {
      if (buf) process.stderr.write(buf);
    });
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

    const source = extractField(content, "source");
    if (source !== opts.name) {
      throw new Error(
        `output ${file} declares source=${source ?? "(missing)"}; expected ${opts.name}`,
      );
    }
    const collection = extractField(content, "collection");
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
