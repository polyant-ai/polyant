// SPDX-License-Identifier: AGPL-3.0-or-later

import { join } from "path";
import { compatiblePluginRoots, importDefinitions } from "../plugin-system/plugin-load.js";
import { getCoreHooksDir } from "./hook-loader-dirs.js";
import { registerHook } from "./hook-registry.js";
import type { HookFunctionDefinition } from "./hook-types.js";

// ---------------------------------------------------------------------------
// Loader: scan the core hooks dir (no namespace) then each plugin root's
// `hooksDir` under its namespace. Mirrors loadAllTools() in
// agents/tools/registry.ts (a hook default-exports a HookFunctionDefinition,
// detected by the presence of a `handler` function — the analogue of a tool's
// `inputSchema`).
// ---------------------------------------------------------------------------

/** True when a default export looks like a HookFunctionDefinition. */
function hasHandler(def: unknown): def is HookFunctionDefinition {
  return (
    !!def &&
    typeof def === "object" &&
    typeof (def as { handler?: unknown }).handler === "function"
  );
}

/** Import every `*.hook.(ts|js)` in `dir`. A file whose default export lacks a
 * `handler` is skipped with a warning. */
const importRoot = (dir: string, namespace: string | null): Promise<void> =>
  importDefinitions({
    dir,
    pattern: /\.hook\.(ts|js)$/,
    namespace,
    kind: "hook",
    definer: "defineHook",
    isDefinition: hasHandler,
    register: registerHook,
  });

/**
 * Discover + load all hook functions: the core hooks dir (flat names) plus every
 * plugin root resolved from `PLUGIN_DIRS` + the convention dir (`src|dist/plugins/*`,
 * same as the tool loader), each under its manifest namespace. Plugins outside
 * the engine version range are skipped with a warning. Fails the boot loudly on
 * a duplicate final name (via registerHook).
 */
export async function loadAllHooks(): Promise<void> {
  const coreDir = getCoreHooksDir();
  await importRoot(coreDir, null);

  // coreDir is <src|dist>/hooks/functions → the convention dir is <src|dist>/plugins.
  const conventionDir = join(coreDir, "..", "..", "plugins");
  // The tool loader reports incompatible plugins; this walk stays quiet about them.
  for (const { root, manifest } of compatiblePluginRoots(conventionDir, { warn: false })) {
    await importRoot(join(root, manifest.hooksDir), manifest.namespace);
  }
}
