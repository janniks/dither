import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./home";

export interface InstalledPluginInfo {
  name: string;
  version: string;
  installedAt?: string;
  schedule?: string;
  collections: string[];
  net: string[];
}

interface GrantsFile {
  version?: string;
  installedAt?: string;
  net?: string[];
  collections?: string[];
  /** User's effective schedule. `null` = manual-only, absent = legacy
   *  grants file (treated as manual-only). */
  schedule?: string | null;
}

export async function listPlugins(): Promise<InstalledPluginInfo[]> {
  const home = resolveHome();
  const grantsDir = join(home, "grants");
  if (!existsSync(grantsDir)) return [];

  const files = await readdir(grantsDir);
  const out: InstalledPluginInfo[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    const grants = JSON.parse(await readFile(join(grantsDir, file), "utf-8")) as GrantsFile;
    out.push({
      name,
      version: grants.version ?? "?",
      ...(grants.installedAt ? { installedAt: grants.installedAt } : {}),
      ...(grants.schedule ? { schedule: grants.schedule } : {}),
      collections: grants.collections ?? [],
      net: grants.net ?? [],
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
