// SPDX-License-Identifier: AGPL-3.0-or-later

// Inline "phantom field" brand pattern: no private helper type (avoids the
// "exported type uses private name" error if .d.ts were ever emitted) and no
// `unique symbol`. The `__brand` field is type-level only — never present at runtime.
//
// The brand PAYLOAD strings below are deliberately still "InstanceSlug" /
// "InstanceUuid" while the type NAMES are AgentSlug / AgentUuid. Brands are
// nominal on that literal, and `@polyant-ai/plugin-sdk` declares the same
// phantom brands (`ToolContext.instanceId: InstanceSlug`) as part of its public
// plugin contract. Changing the payload here would make every SDK-authored tool
// and hook fail to typecheck against the engine. The payload follows once the
// SDK renames its own contract (plugin-sdk v1.6.0, additive with deprecated aliases);
// until then this is an internal implementation detail with no runtime effect.

/** Human-readable agent identifier (the `agents.slug` column). */
export type AgentSlug = string & { readonly __brand: "InstanceSlug" };

/** Agent UUID primary key (the `agents.id` column) and FK columns that reference it. */
export type AgentUuid = string & { readonly __brand: "InstanceUuid" };

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
