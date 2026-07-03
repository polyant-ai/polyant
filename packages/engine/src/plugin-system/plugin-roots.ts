// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { readPluginManifest, type PluginManifest } from "./plugin-manifest.js";

export interface PluginRoot {
  root: string;
  manifest: PluginManifest;
}

/**
 * Resolve the plugin roots the loader will scan, from two sources unioned and
 * de-duplicated by manifest `name`:
 *   1. `envDirs` — absolute paths from PLUGIN_DIRS (dev / explicit override). Win de-dup.
 *   2. `conventionDir` — every immediate subdir of `src/plugins` (or `dist/plugins`)
 *      that carries a `plugin.json`.
 * A directory without a valid `plugin.json` is silently skipped.
 */
export function resolvePluginRoots(opts: { envDirs: string[]; conventionDir: string }): PluginRoot[] {
  const byName = new Map<string, PluginRoot>();
  const add = (dir: string) => {
    const root = resolve(dir);
    const manifest = readPluginManifest(root);
    if (!manifest) return;
    if (!byName.has(manifest.name)) byName.set(manifest.name, { root, manifest });
  };
  // Env dirs first → they win de-dup over the convention dir.
  for (const d of opts.envDirs) add(d);
  if (existsSync(opts.conventionDir)) {
    for (const entry of readdirSync(opts.conventionDir, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(opts.conventionDir, entry.name));
    }
  }
  return Array.from(byName.values());
}
