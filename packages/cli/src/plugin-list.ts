import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "./home";

export interface InstalledPluginInfo {
  name: string;
  version: string;
  installedAt?: string;
  schedule?: string;
  create: string[];
  edit: string[];
  net: string[];
  /** Parsed watch declaration. `null` = explicitly disabled,
   *  `undefined` = absent (legacy grants — treated as disabled).
   *  `collections` are manifest-consented library collections; `dirs` are
   *  arbitrary absolute paths the user added via `plugin run --watch`. */
  watch?: { collections: string[]; dirs?: string[]; glob?: string } | null;
}

interface GrantsFile {
  version?: string;
  installedAt?: string;
  net?: string[];
  create?: string[];
  edit?: string[];
  /** User's effective schedule. `null` = manual-only, absent = legacy
   *  grants file (treated as manual-only). */
  schedule?: string | null;
  watch?: { collections: string[]; dirs?: string[]; glob?: string } | null;
}

export async function listPlugins(): Promise<InstalledPluginInfo[]> {
  const home = resolveHome();
  const grantsDir = join(home, "grants");
  if (!existsSync(grantsDir)) return [];

  const files = (await readdir(grantsDir)).filter((f) => f.endsWith(".json"));
  const out = await Promise.all(
    files.map(async (file) => {
      const name = file.slice(0, -".json".length);
      const grants = JSON.parse(await readFile(join(grantsDir, file), "utf-8")) as GrantsFile;
      return {
        name,
        version: grants.version ?? "?",
        ...(grants.installedAt ? { installedAt: grants.installedAt } : {}),
        ...(grants.schedule ? { schedule: grants.schedule } : {}),
        create: grants.create ?? [],
        edit: grants.edit ?? [],
        net: grants.net ?? [],
        ...(grants.watch !== undefined ? { watch: grants.watch } : {}),
      };
    }),
  );
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
