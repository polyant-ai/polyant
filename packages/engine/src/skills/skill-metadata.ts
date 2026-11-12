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

/**
 * The `metadata` a skill write stores: the requirements the caller declared. On an
 * update, `stored` is the current version's metadata, and a requirement the caller
 * left out keeps its stored value; one it sent, an empty list included, replaces it.
 */
export function buildSkillMetadata(
  data: { requiredEnv?: unknown[]; requiredTools?: string[] },
  stored: SkillVersionMetadata = {},
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const requiredEnv = data.requiredEnv ?? stored.requiredEnv;
  const requiredTools = data.requiredTools ?? stored.requiredTools;
  if (requiredEnv) metadata.requiredEnv = requiredEnv;
  if (requiredTools) metadata.requiredTools = requiredTools;
  return metadata;
}
