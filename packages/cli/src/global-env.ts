import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { globalEnvPath } from "./home";

/**
 * dither-managed global env store. Plain JSON at ~/.dither/env.json.
 * Has nothing to do with shell env vars — this is its own namespace.
 *
 * Plugins read these values when they were granted via `--allow-env <name>`.
 */

async function readStore(): Promise<Record<string, string>> {
  const path = globalEnvPath();
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf-8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as Record<string, string>;
}

async function writeStore(store: Record<string, string>): Promise<void> {
  const path = globalEnvPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf-8");
}

export async function getGlobalEnv(name: string): Promise<string | undefined> {
  const store = await readStore();
  return store[name];
}

export async function setGlobalEnv(name: string, value: string): Promise<void> {
  const store = await readStore();
  store[name] = value;
  await writeStore(store);
}

export async function unsetGlobalEnv(name: string): Promise<boolean> {
  const store = await readStore();
  if (!(name in store)) return false;
  delete store[name];
  await writeStore(store);
  return true;
}

export async function listGlobalEnv(): Promise<Record<string, string>> {
  return readStore();
}
