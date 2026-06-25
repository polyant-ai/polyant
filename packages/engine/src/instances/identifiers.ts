// SPDX-License-Identifier: AGPL-3.0-or-later

// Inline "phantom field" brand pattern: no private helper type (avoids the
// "exported type uses private name" error if .d.ts were ever emitted) and no
// `unique symbol`. The `__brand` field is type-level only — never present at runtime.

/** Human-readable agent identifier (the `agents.slug` column). */
export type AgentSlug = string & { readonly __brand: "AgentSlug" };

/** Agent UUID primary key (the `agents.id` column) and FK columns that reference it. */
export type AgentUuid = string & { readonly __brand: "AgentUuid" };

/**
 * Zero-cost cast to {@link AgentSlug}. Use ONLY for trusted sources: DB reads
 * of `agents.slug`, the config default, or an already-validated URL param.
 */
export const asAgentSlug = (s: string): AgentSlug => s as AgentSlug;

/**
 * Zero-cost cast to {@link AgentUuid}. Use ONLY for trusted sources: DB reads
 * of `agents.id` / a uuid FK column.
 */
export const asAgentUuid = (s: string): AgentUuid => s as AgentUuid;
