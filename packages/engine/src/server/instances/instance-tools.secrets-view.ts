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
