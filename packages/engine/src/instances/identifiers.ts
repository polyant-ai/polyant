// SPDX-License-Identifier: AGPL-3.0-or-later

// Inline "phantom field" brand pattern: no private helper type (avoids the
// "exported type uses private name" error if .d.ts were ever emitted) and no
// `unique symbol`. The `__brand` field is type-level only — never present at runtime.

/** Human-readable instance identifier (the `instances.slug` column). */
export type InstanceSlug = string & { readonly __brand: "InstanceSlug" };

/** Instance UUID primary key (the `instances.id` column) and FK columns that reference it. */
export type InstanceUuid = string & { readonly __brand: "InstanceUuid" };

/**
 * Zero-cost cast to {@link InstanceSlug}. Use ONLY for trusted sources: DB reads
 * of `instances.slug`, the config default, or an already-validated URL param.
 */
export const asInstanceSlug = (s: string): InstanceSlug => s as InstanceSlug;

/**
 * Slug format contract, shared by every entry point that accepts an external
 * slug (HTTP API, snapshot CLI). Slugs are used as path segments (workspace
 * dirs, snapshot folders) and URL/conversationId components, so the format
 * must stay path- and separator-safe: no `/`, `\`, `..` or uppercase.
 */
export const INSTANCE_SLUG_MAX_LENGTH = 100;
export const INSTANCE_SLUG_PATTERN = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;

export function isValidInstanceSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= INSTANCE_SLUG_MAX_LENGTH &&
    INSTANCE_SLUG_PATTERN.test(slug)
  );
}

/**
 * Zero-cost cast to {@link InstanceUuid}. Use ONLY for trusted sources: DB reads
 * of `instances.id` / a uuid FK column.
 */
export const asInstanceUuid = (s: string): InstanceUuid => s as InstanceUuid;
