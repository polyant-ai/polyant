// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";

const DEFAULT_DATABASE_URL = "postgresql://localhost:5432/polyant_enterprise";

/**
 * Load the tool registry without starting the engine so documentation tooling
 * can serialize the complete public catalog.
 */
export async function exportToolCatalog() {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  process.env.AUTH_SECRET ??= "a".repeat(32);
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;

  const { _resetRegistryForTests, listAvailableTools, loadAllTools } = await import(
    "../agents/tools/registry.js"
  );
  _resetRegistryForTests();
  await loadAllTools({ pruneRequiredEnv: false });

  return { tools: listAvailableTools() };
}

async function main(): Promise<void> {
  const catalog = await exportToolCatalog();
  process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
