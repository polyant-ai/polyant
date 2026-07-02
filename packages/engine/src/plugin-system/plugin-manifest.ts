// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { satisfies, valid, validRange } from "semver";
import { z } from "zod";

/**
 * A plugin repo declares a `plugin.json` at its root. This is the discovery
 * contract: `name` + `namespace` decide the tool-name prefix, `engine` gates
 * compatibility, `toolsDir` says where the `*.tool.ts` files live.
 */
export const pluginManifestSchema = z.object({
  /** Stable plugin id (also the conventional install dir name). */
  name: z.string().min(1),
  /** Plugin version (independent of the engine version). */
  version: z.string().min(1),
  /** Engine compatibility range (semver range, e.g. ">=0.1.0"). */
  engine: z.string().min(1),
  /** Directory (relative to the plugin root) scanned for *.tool.ts. Defaults to "tools". */
  toolsDir: z.string().min(1).default("tools"),
  /** Tool-name prefix applied to every tool in this plugin. Defaults to `name`.
   * Empty string is rejected — there is no "unprefixed plugin" option. */
  namespace: z.string().min(1).optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema> & { namespace: string };

/**
 * Read + validate `<root>/plugin.json`. Returns null (not throws) when the file
 * is absent or invalid — a non-plugin directory is silently skipped by the
 * resolver, but a malformed manifest is logged so a typo is diagnosable.
 */
export function readPluginManifest(root: string): PluginManifest | null {
  const file = join(root, "plugin.json");
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`Plugin manifest at ${file} is not valid JSON — skipping: ${(err as Error).message}`);
    return null;
  }
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`Plugin manifest at ${file} failed validation — skipping: ${parsed.error.message}`);
    return null;
  }
  // Namespace defaults to name; guaranteed non-empty by the schema when present.
  return { ...parsed.data, namespace: parsed.data.namespace ?? parsed.data.name };
}

/**
 * True when `engineVersion` satisfies the plugin's declared `engine` range.
 * Fail-closed: an unparseable range or version returns false (skip the plugin)
 * rather than wrongly loading an incompatible one.
 */
export function engineSatisfies(manifest: PluginManifest, engineVersion: string): boolean {
  if (!valid(engineVersion) || !validRange(manifest.engine)) return false;
  return satisfies(engineVersion, manifest.engine);
}
