import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveHome } from "./home";
import { parsePackage, type ParsedPackage } from "./manifest";
import { validateGrantPattern } from "./collection-paths";
import { maybeWarnInstall } from "./tcc-hint";
import { ensureDeno } from "./deno-bootstrap";
import { MissingInputsError, planInstall, type InstallInputs } from "./plugin-install-interactive";

export type InstallOptions = InstallInputs & { source: string };

export interface InstalledPlugin {
  name: string;
  version: string;
  dest: string;
}

export { MissingInputsError } from "./plugin-install-interactive";

export async function installPlugin(opts: InstallOptions): Promise<InstalledPlugin> {
  // Trigger the managed-deno bootstrap on first install so the user pays the
  // download cost here rather than mid-run. Idempotent; cheap on later calls.
  await ensureDeno();

  const sourcePath = resolve(opts.source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Plugin source not found: ${sourcePath}`);
  }
  const pkgPath = join(sourcePath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json at ${sourcePath}`);
  }

  const pkgRaw = JSON.parse(await readFile(pkgPath, "utf-8")) as unknown;
  const parsed: ParsedPackage = parsePackage(pkgRaw);

  // Validate everything before touching disk so a missing-required failure
  // rolls back cleanly with no half-installed state.
  const plan = await planInstall(parsed, opts);
  if (!plan.ok) throw new MissingInputsError(plan.missing);
  const { env, envRefs, files, net, collections } = plan.resolved;
  for (const pattern of collections) validateGrantPattern(pattern);

  const home = resolveHome();
  const destDir = join(home, "plugins", parsed.name);

  // Reinstall is intentionally non-atomic for v0 simplicity: rm → mkdir → cp.
  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }
  await mkdir(destDir, { recursive: true });
  await cp(sourcePath, destDir, { recursive: true });

  const grantsDir = join(home, "grants");
  await mkdir(grantsDir, { recursive: true });
  const grantsPath = join(grantsDir, `${parsed.name}.json`);
  await writeFile(
    grantsPath,
    JSON.stringify(
      {
        name: parsed.name,
        version: parsed.version,
        installedAt: new Date().toISOString(),
        manifest: parsed.manifest,
        env,
        envRefs,
        files,
        net,
        collections,
      },
      null,
      2,
    ),
  );

  maybeWarnInstall(files);

  return { name: parsed.name, version: parsed.version, dest: destDir };
}
