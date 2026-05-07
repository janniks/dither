import { saveConfig } from "../../src/config";

/**
 * Write a minimal valid config pointing at the given library path. Tests use
 * this in beforeEach to satisfy `assertInitialized` and the new library
 * resolver without invoking the full `dither init` command.
 */
export async function writeTestConfig(libraryPath: string): Promise<void> {
  await saveConfig({
    schema: { version: 1 },
    library: { path: libraryPath },
  });
}
