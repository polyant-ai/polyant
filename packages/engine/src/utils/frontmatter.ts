// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// RequiredEnv normalizer
// ---------------------------------------------------------------------------

export interface RequiredEnvEntry {
  name: string;
  description?: string;
  sensitive: boolean;
}

/** Normalize requiredEnv from frontmatter: supports both string[] and object[] formats. */
export function normalizeRequiredEnv(raw: unknown): RequiredEnvEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") {
        return { name: item, sensitive: true };
      }
      if (typeof item === "object" && item !== null && "name" in item) {
        return {
          name: String(item.name),
          description: item.description ? String(item.description) : undefined,
          sensitive: item.sensitive !== false, // default true
        };
      }
      return null;
    })
    .filter((x): x is RequiredEnvEntry => x !== null);
}
