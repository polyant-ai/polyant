// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RequiredSecretSpec } from "../../agents/tools/registry.js";

/** Spec returned to the admin UI: includes `currentValue` for non-sensitive fields. */
export type RequiredSecretSpecWithValue = RequiredSecretSpec & { currentValue?: string };

/** Minimal shape consumed from `listAvailableTools()` — only what this view needs. */
interface ToolWithSecrets {
  name: string;
  requiredSecrets?: RequiredSecretSpec[];
}

/**
 * Pure: collect the deduped, key-sorted secret specs across the instance's
 * enabled tools. First-seen wins on key collisions. An empty `enabledNames`
 * means "all tools enabled" (preserves the original endpoint semantics).
 */
export function collectEnabledToolSecrets(
  allTools: ToolWithSecrets[],
  enabledNames: Set<string>,
): RequiredSecretSpec[] {
  const specsByKey = new Map<string, RequiredSecretSpec>();
  // An empty set means "no enablement filter" → all tools count as enabled.
  const allEnabled = enabledNames.size === 0;
  for (const t of allTools) {
    const isEnabled = allEnabled || enabledNames.has(t.name);
    if (isEnabled && t.requiredSecrets) {
      for (const spec of t.requiredSecrets) {
        if (!specsByKey.has(spec.key)) {
          specsByKey.set(spec.key, spec);
        }
      }
    }
  }
  return Array.from(specsByKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Pure: the deduped, key-sorted required-secret specs an instance needs — the
 * union of its enabled TOOLS and enabled HOOKS. Tool specs win on key collisions
 * (first-seen). `enabledHooks` is passed already filtered to the instance's
 * enabled hooks, so every entry counts (kept separate from the tool call to
 * preserve the tools' legacy "empty set = all tools" semantics).
 */
export function collectInstanceRequiredSecrets(
  allTools: ToolWithSecrets[],
  enabledToolNames: Set<string>,
  enabledHooks: ToolWithSecrets[],
): RequiredSecretSpec[] {
  const toolSpecs = collectEnabledToolSecrets(allTools, enabledToolNames);
  const hookSpecs = collectEnabledToolSecrets(enabledHooks, new Set(enabledHooks.map((h) => h.name)));
  const byKey = new Map<string, RequiredSecretSpec>();
  for (const spec of [...toolSpecs, ...hookSpecs]) {
    if (!byKey.has(spec.key)) byKey.set(spec.key, spec);
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Pure: map an instance's hook rows to the secret sources
 * {@link collectInstanceRequiredSecrets} expects. Skips disabled hooks and hooks
 * whose function is not registered (`lookup` returns undefined). `lookup` is
 * injected so this stays independent of the hook-registry singleton.
 */
export function enabledHookSecretSources(
  hooks: ReadonlyArray<{ enabled: boolean; actionConfig: { functionName: string } }>,
  lookup: (functionName: string) => { name: string; requiredSecrets: RequiredSecretSpec[] } | undefined,
): ToolWithSecrets[] {
  return hooks
    .filter((h) => h.enabled)
    .map((h) => lookup(h.actionConfig.functionName))
    .filter((d): d is { name: string; requiredSecrets: RequiredSecretSpec[] } => Boolean(d))
    .map((d) => ({ name: d.name, requiredSecrets: d.requiredSecrets }));
}

/**
 * Pure: attach `currentValue` (cleartext) to every non-sensitive spec that has
 * a stored value. Sensitive specs never carry a value — this is the readability
 * boundary enforced server-side.
 *
 * Expects fully-normalized specs where `sensitive` is always defined, as
 * guaranteed by `normalizeRequiredSecrets` / `listAvailableTools`. The strict
 * `=== false` check is intentional: a spec with `sensitive` left `undefined` is
 * conservatively treated as a secret and never echoed (safe default).
 */
export function attachReadableValues(
  specs: RequiredSecretSpec[],
  currentSecrets: Record<string, string>,
): RequiredSecretSpecWithValue[] {
  return specs.map((spec) => {
    if (spec.sensitive === false) {
      const currentValue = currentSecrets[spec.key];
      return currentValue ? { ...spec, currentValue } : { ...spec };
    }
    return { ...spec };
  });
}
