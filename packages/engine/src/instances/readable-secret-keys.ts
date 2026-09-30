// SPDX-License-Identifier: AGPL-3.0-or-later

import { getToolRegistry, normalizeRequiredSecrets, type RequiredSecretSpec } from "../agents/tools/registry.js";
import { getHookRegistry } from "../hooks/hook-registry.js";

interface SecretSource {
  requiredSecrets?: readonly RequiredSecretSpec[];
}

/**
 * The keys that hold a readable PARAMETER rather than a credential.
 *
 * `instance_secrets` stores both: a tool's API key and a tool's base URL or
 * `select` choice live in the same table, encrypted alike. What tells them apart
 * is the spec a tool or hook declares, and only `sensitive: false` makes a key
 * readable. The verdict is fail-closed on every ambiguity: a key that no loaded
 * tool or hook declares is a credential, and a key that one source declares
 * readable and another declares sensitive is a credential too.
 */
export function readableKeysOf(sources: Iterable<SecretSource>): Set<string> {
  const readable = new Set<string>();
  const sensitive = new Set<string>();
  for (const source of sources) {
    for (const spec of source.requiredSecrets ?? []) {
      (spec.sensitive === false ? readable : sensitive).add(spec.key);
    }
  }
  for (const key of sensitive) readable.delete(key);
  return readable;
}

/**
 * {@link readableKeysOf} over every tool and hook registered in this process,
 * harness tools included: a harness tool that declares a key sensitive must
 * still veto it.
 */
export function readableSecretKeys(): Set<string> {
  const tools = [...getToolRegistry().values()].map((def) => ({
    requiredSecrets: normalizeRequiredSecrets(def.requiredSecrets, def.name),
  }));
  return readableKeysOf([...tools, ...getHookRegistry().values()]);
}
