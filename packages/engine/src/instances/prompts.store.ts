// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Prompts data store — CRUD for instance_prompts
// ---------------------------------------------------------------------------

import { eq, and, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { agentPrompts } from "./prompts.schema.js";
import { DEFAULT_PROMPTS } from "./defaults.js";
import { TtlCache } from "../utils/ttl-cache.js";
import { asAgentUuid, type AgentUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptRow {
  id: string;
  agentId: AgentUuid;
  sectionKey: string;
  title: string;
  content: string;
  updatedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Cache (60s TTL)
// ---------------------------------------------------------------------------

const cache = new TtlCache<string, PromptRow[]>({ maxSize: 200, ttlMs: 60_000 });

export function invalidatePromptsCache(agentId: AgentUuid): void {
  cache.delete(agentId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Get all prompt sections for an instance. Cached with 60s TTL. */
export async function getPrompts(agentId: AgentUuid): Promise<PromptRow[]> {
  const cached = cache.get(agentId);
  if (cached) {
    return cached;
  }

  const rawRows = await db
    .select()
    .from(agentPrompts)
    .where(eq(agentPrompts.agentId, agentId))
    .orderBy(agentPrompts.sectionKey);

  const rows: PromptRow[] = rawRows.map((r) => ({ ...r, agentId: asAgentUuid(r.agentId) }));
  cache.set(agentId, rows);
  return rows;
}

/** Get a single prompt section. */
export async function getPromptSection(
  agentId: AgentUuid,
  sectionKey: string,
): Promise<PromptRow | null> {
  const [row] = await db
    .select()
    .from(agentPrompts)
    .where(
      and(
        eq(agentPrompts.agentId, agentId),
        eq(agentPrompts.sectionKey, sectionKey),
      ),
    )
    .limit(1);
  return row ? { ...row, agentId: asAgentUuid(row.agentId) } : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Upsert a single prompt section. Invalidates cache. */
export async function upsertPrompt(
  agentId: AgentUuid,
  sectionKey: string,
  title: string,
  content: string,
): Promise<void> {
  await db
    .insert(agentPrompts)
    .values({ agentId, sectionKey, title, content })
    .onConflictDoUpdate({
      target: [agentPrompts.agentId, agentPrompts.sectionKey],
      set: { title, content, updatedAt: sql`now()` },
    });
  invalidatePromptsCache(agentId);
}

/**
 * Seed all 8 default prompt sections for an instance.
 * Idempotent: uses ON CONFLICT DO NOTHING on the (agentId, sectionKey) unique constraint
 * so concurrent calls cannot produce duplicates (no count+insert TOCTOU).
 */
export async function seedInstancePrompts(agentId: AgentUuid): Promise<void> {
  await db
    .insert(agentPrompts)
    .values(
      DEFAULT_PROMPTS.map((p) => ({
        agentId,
        sectionKey: p.sectionKey,
        title: p.title,
        content: p.content,
      })),
    )
    .onConflictDoNothing({ target: [agentPrompts.agentId, agentPrompts.sectionKey] });
  invalidatePromptsCache(agentId);
}
