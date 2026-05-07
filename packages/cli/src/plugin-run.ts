import { mkdir, readFile, writeFile, readdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { resolveHome } from "./home";
import { parsePackage } from "./manifest";
import { updateIndex } from "./update-index";
import { getGlobalEnv } from "./global-env";
import { validateCollectionPath, validateGrantPattern, grantsCover } from "./collection-paths";
import { acquire as acquireLock, release as releaseLock } from "./locks";
import { startRun, type RunJournal } from "./journal";

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

interface ParsedFrontmatter {
  source?: unknown;
  collection?: unknown;
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

interface PromoteCandidate {
  src: string;
  dest: string;
  collection: string;
  filename: string;
}

async function planPromotion(
  runDir: string,
  pluginName: string,
  home: string,
  allowedCollections: readonly string[],
): Promise<PromoteCandidate[]> {
  const entries = await readdir(runDir);
  const out: PromoteCandidate[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(".md")) continue;
    const src = join(runDir, filename);
    const content = await readFile(src, "utf-8");
    const data = matter(content).data as ParsedFrontmatter;

    const source = typeof data.source === "string" ? data.source : null;
    if (source !== pluginName) {
      throw new Error(
        `output ${filename} declares source=${source ?? "(missing)"}; expected ${pluginName}`,
      );
    }
    const collection = typeof data.collection === "string" ? data.collection : null;
    if (!collection) {
      throw new Error(`output ${filename} missing 'collection' frontmatter`);
    }
    validateCollectionPath(collection);
    if (!grantsCover(allowedCollections, collection)) {
      throw new Error(
        `plugin '${pluginName}' is not granted write access to collection '${collection}'`,
      );
    }

    const destDir = join(home, "entries", collection);
    const dest = join(destDir, filename);
    if (existsSync(dest)) {
      const existing = await readFile(dest, "utf-8");
      const existingSource = (matter(existing).data as ParsedFrontmatter).source;
      if (existingSource !== pluginName) {
        throw new Error(
          `output ${filename} would clobber an existing entry at '${collection}/${filename}' (source=${
            typeof existingSource === "string" ? existingSource : "(missing)"
          }, this plugin=${pluginName})`,
        );
      }
    }

    out.push({ src, dest, collection, filename });
  }
  return out;
}

async function copyPromoted(candidates: PromoteCandidate[]): Promise<string[]> {
  const promoted: string[] = [];
  for (const c of candidates) {
    await mkdir(join(c.dest, ".."), { recursive: true });
    await copyFile(c.src, c.dest);
    promoted.push(c.dest);
  }
  return promoted;
}

export async function runPlugin(opts: RunOptions): Promise<RunResult> {
  const home = resolveHome();
  const pluginDir = join(home, "plugins", opts.name);
  if (!existsSync(pluginDir)) {
    throw new Error(`Plugin not installed: ${opts.name}`);
  }

  // Single-arbiter check: only one run of this plugin at a time. Schedule,
  // watch, and manual fires all funnel through the same lock.
  const lock = await acquireLock(opts.name);
  if (!lock) {
    throw new Error(
      `Plugin '${opts.name}' is already running. Wait for it to finish, or check 'dither status'.`,
    );
  }

  const trigger = opts.trigger ?? "manual";
  const { journal, runId } = await startRun(opts.name, trigger);

  try {
    const promoted = await runPluginLocked(opts, home, pluginDir, journal, runId, trigger);
    await journal.close({
      status: "ok",
      finishedAt: new Date().toISOString(),
      promoted,
    });
    return { runId, promoted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = (err as { exitCode?: number }).exitCode;
    const stderrTail = (err as { stderrTail?: string }).stderrTail;
    await journal.append("error", { message }).catch(() => {});
    await journal
      .close({
        status: "fail",
        finishedAt: new Date().toISOString(),
        error: message,
        exitCode,
        stderrTail,
      })
      .catch(() => {});
    throw err;
  } finally {
    await releaseLock(lock);
  }
}

async function runPluginLocked(
  opts: RunOptions,
  home: string,
  pluginDir: string,
  journal: RunJournal,
  runId: string,
  trigger: string,
): Promise<string[]> {
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
  for (const pattern of grantCollections) validateGrantPattern(pattern);

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

  const runDir = join(home, "runs", runId);
  await mkdir(runDir, { recursive: true });

  try {
    const stateDir = join(pluginDir, "state");
    await mkdir(stateDir, { recursive: true });
    const stateFile = join(stateDir, "state.json");

    const inputFile = join(runDir, "input.json");
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

    const stderrLines: string[] = [];
    const STDERR_TAIL_MAX = 50;
    function recordStderr(line: string): void {
      stderrLines.push(line);
      if (stderrLines.length > STDERR_TAIL_MAX) stderrLines.shift();
    }

    await new Promise<void>((res, rej) => {
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
          if (msg) {
            void journal.append("progress", {
              message: msg.message,
              done: msg.done,
              total: msg.total,
            });
            if (opts.onProgress) opts.onProgress(msg);
          } else {
            recordStderr(line);
            void journal.append("stderr", { line });
            process.stderr.write(`${line}\n`);
          }
        }
      });
      child.stderr!.on("end", () => {
        if (buf) {
          recordStderr(buf);
          void journal.append("stderr", { line: buf });
          process.stderr.write(buf);
        }
      });
      child.on("error", rej);
      child.on("exit", (code) => {
        if (code === 0) res();
        else {
          const err = new Error(`plugin '${opts.name}' exited with code ${code}`);
          (err as Error & { exitCode?: number; stderrTail?: string }).exitCode = code ?? -1;
          (err as Error & { exitCode?: number; stderrTail?: string }).stderrTail =
            stderrLines.join("\n");
          rej(err);
        }
      });
    });

    // Two-pass promote: validate every output, then copy. Any validation
    // failure throws before any file is moved into entries/, so a partial
    // promote is impossible.
    const candidates = await planPromotion(runDir, opts.name, home, grantCollections);
    const promoted = await copyPromoted(candidates);
    for (const path of promoted) {
      await journal.append("promoted", { path });
    }

    if (promoted.length > 0) {
      await updateIndex();
    }

    return promoted;
  } finally {
    // Always clean up the run dir — failed runs would otherwise leave
    // input.json (containing plaintext env values, possibly secrets) on disk.
    await rm(runDir, { recursive: true, force: true });
  }
}
