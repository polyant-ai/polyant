// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HookFunctionDefinition } from "./hook-types.js";

// ---------------------------------------------------------------------------
// Registry (engine-owned singleton Map — the loader is its only writer).
// Mirrors the tool registry in agents/tools/registry.ts.
// ---------------------------------------------------------------------------

const registry = new Map<string, HookFunctionDefinition>();

function assertUniqueName(finalName: string): void {
  if (registry.has(finalName)) {
    throw new Error(`Duplicate hook registration: "${finalName}" is already registered.`);
  }
}

/** Register a hook definition under an optional plugin namespace. The loader is
 * the only caller; tests use `_registerHookForTests`. */
export function registerHook(def: HookFunctionDefinition, namespace: string | null): void {
  const finalName = namespace ? `${namespace}:${def.name}` : def.name;
  assertUniqueName(finalName);
  registry.set(finalName, namespace ? { ...def, name: finalName } : def);
}

/** TEST ONLY: register a hook definition directly (bypasses the loader). */
export function _registerHookForTests(def: HookFunctionDefinition, namespace: string | null = null): void {
  registerHook(def, namespace);
}

/** TEST ONLY: clear the registry between unit tests. */
export function _resetHookRegistryForTests(): void {
  registry.clear();
}

/** Read-only view of the full hook registry. */
export function getHookRegistry(): ReadonlyMap<string, HookFunctionDefinition> {
  return registry;
}
