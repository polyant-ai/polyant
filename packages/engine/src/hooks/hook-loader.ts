// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import { errMsg } from "../utils/error.js";
import { resolvePluginRoots } from "../plugin-system/plugin-roots.js";
import { engineSatisfies } from "../plugin-system/plugin-manifest.js";
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

// Engine version, read lazily so merely importing this module touches no fs
// (keeps partial fs mocks in tests working). Fail-closed to "0.0.0" so an
// unreadable package.json makes realistic engine ranges fail → incompatible
// plugins are skipped rather than wrongly loaded. Mirrors registry.ts.
// ponytail: duplicated from registry.ts (private there); extracting it would
// touch the tool loader — out of scope for an additive change.
let _engineVersion: string | undefined;
function getEngineVersion(): string {
  if (_engineVersion !== undefined) return _engineVersion;
  try {
    _engineVersion = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).version as string;
  } catch {
    _engineVersion = "0.0.0";
  }
  return _engineVersion;
}

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
async function importRoot(dir: string, namespace: string | null): Promise<void> {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => /\.hook\.(ts|js)$/.test(f));
  for (const file of files) {
    try {
      const mod = (await import(join(dir, file))) as { default?: unknown };
      if (hasHandler(mod.default)) {
        registerHook(mod.default, namespace);
      } else {
        console.warn(`Hook file "${file}" has no defineHook default export — skipping`);
      }
    } catch (err) {
      // Third-party plugin code must never abort engine boot: log + skip. Core
      // hooks (no namespace) are first-party — a broken one is a real bug, so
      // rethrow to fail loudly at boot.
      if (namespace === null) throw err;
      console.warn(
        `Plugin "${namespace}" hook file "${file}" failed to load: ${errMsg(err)} — skipping`,
      );
    }
  }
}

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
  const roots = resolvePluginRoots({ envDirs: config.plugins.dirs, conventionDir });
  for (const { root, manifest } of roots) {
    if (!engineSatisfies(manifest, getEngineVersion())) {
      console.warn(
        `Plugin "${manifest.name}" requires engine ${manifest.engine}, have ${getEngineVersion()} — skipping`,
      );
      continue;
    }
    await importRoot(join(root, manifest.hooksDir), manifest.namespace);
  }
}
