// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import { errMsg } from "../utils/error.js";
import { resolvePluginRoots, type PluginRoot } from "./plugin-roots.js";
import { engineSatisfies } from "./plugin-manifest.js";
import { createLogger } from "../utils/create-logger.js";

const log = createLogger();

// Engine version, read lazily so merely importing this module touches no fs
// (keeps partial fs mocks in tests working). Fail-closed to "0.0.0" so an
// unreadable package.json makes realistic engine ranges fail → incompatible
// plugins are skipped rather than wrongly loaded.
let _engineVersion: string | undefined;
export function getEngineVersion(): string {
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

/**
 * The plugin roots (`PLUGIN_DIRS` plus the convention dir) whose manifest
 * accepts this engine. An incompatible plugin is skipped with a warning, unless
 * `warn` is false — the tool loader and the hook loader walk the same roots at
 * boot, and only one of them needs to say so.
 */
export function compatiblePluginRoots(conventionDir: string, opts: { warn?: boolean } = {}): PluginRoot[] {
  const warn = opts.warn ?? true;
  return resolvePluginRoots({ envDirs: config.plugins.dirs, conventionDir }).filter(({ manifest }) => {
    if (engineSatisfies(manifest, getEngineVersion())) return true;
    if (warn) {
      log.warn(
        "plugins",
        `Plugin "${manifest.name}" requires engine ${manifest.engine}, have ${getEngineVersion()} — skipping`,
      );
    }
    return false;
  });
}

/**
 * Import every file in `dir` matching `pattern` (sorted, so registration order
 * is stable across filesystems) and hand each default export to `register` when
 * `isDefinition` accepts it; otherwise warn. A file that fails to load aborts
 * boot for a core root (`namespace === null`, first-party, a real bug) and is
 * logged and skipped for a plugin's, which must never take the engine down.
 */
export async function importDefinitions<T>(opts: {
  dir: string;
  pattern: RegExp;
  namespace: string | null;
  /** Singular noun for the warnings, e.g. "tool" or "hook". */
  kind: string;
  /** What a file is missing when it is rejected, e.g. "defineTool". */
  definer: string;
  isDefinition: (value: unknown) => value is T;
  register: (definition: T, namespace: string | null) => void;
}): Promise<void> {
  const { dir, pattern, namespace, kind, definer, isDefinition, register } = opts;
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => pattern.test(f)).sort();
  for (const file of files) {
    try {
      const mod = (await import(join(dir, file))) as { default?: unknown };
      if (isDefinition(mod.default)) {
        register(mod.default, namespace);
      } else {
        log.warn("plugins", `${kind[0].toUpperCase()}${kind.slice(1)} file "${file}" has no ${definer} default export — skipping`);
      }
    } catch (err) {
      if (namespace === null) throw err;
      log.warn("plugins", `Plugin "${namespace}" ${kind} file "${file}" failed to load: ${errMsg(err)} — skipping`);
    }
  }
}
