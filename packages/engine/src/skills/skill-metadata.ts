// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a skill version's `metadata` jsonb may carry. Stored values are
 * untrusted-shape (older rows, imported bundles), so reads go through
 * `parseSkillMetadata`; `requiredEnv` stays loose here because the prompt
 * normalizes its entries.
 */
export interface SkillVersionMetadata {
  name?: string;
  description?: string;
  requiredEnv?: unknown[];
  requiredTools?: string[];
}

/** The typed view of a stored `metadata` value; an absent or non-object value reads as empty. */
export function parseSkillMetadata(raw: unknown): SkillVersionMetadata {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as SkillVersionMetadata) : {};
}

/** The `metadata` a skill write stores: only the requirements the caller declared. */
export function buildSkillMetadata(data: {
  requiredEnv?: unknown[];
  requiredTools?: string[];
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (data.requiredEnv) metadata.requiredEnv = data.requiredEnv;
  if (data.requiredTools) metadata.requiredTools = data.requiredTools;
  return metadata;
}
