// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Prompts data store — CRUD for instance_prompts
// ---------------------------------------------------------------------------

import { eq, and, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { instancePrompts } from "./prompts.schema.js";
import { DEFAULT_PROMPTS } from "./defaults.js";
import { TtlCache } from "../utils/ttl-cache.js";
import { asInstanceUuid, type InstanceUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptRow {
  id: string;
  instanceId: InstanceUuid;
  sectionKey: string;
  title: string;
  content: string;
  updatedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Cache (60s TTL)
// ---------------------------------------------------------------------------

const cache = new TtlCache<string, PromptRow[]>({ maxSize: 200, ttlMs: 60_000 });

export function invalidatePromptsCache(instanceId: InstanceUuid): void {
  cache.delete(instanceId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Get all prompt sections for an instance. Cached with 60s TTL. */
export async function getPrompts(instanceId: InstanceUuid): Promise<PromptRow[]> {
  const cached = cache.get(instanceId);
  if (cached) {
    return cached;
  }

  const rawRows = await db
    .select()
    .from(instancePrompts)
    .where(eq(instancePrompts.instanceId, instanceId))
    .orderBy(instancePrompts.sectionKey);

  const rows: PromptRow[] = rawRows.map((r) => ({ ...r, instanceId: asInstanceUuid(r.instanceId) }));
  cache.set(instanceId, rows);
  return rows;
}

/** Get a single prompt section. */
export async function getPromptSection(
  instanceId: InstanceUuid,
  sectionKey: string,
): Promise<PromptRow | null> {
  const [row] = await db
    .select()
    .from(instancePrompts)
    .where(
      and(
        eq(instancePrompts.instanceId, instanceId),
        eq(instancePrompts.sectionKey, sectionKey),
      ),
    )
    .limit(1);
  return row ? { ...row, instanceId: asInstanceUuid(row.instanceId) } : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Upsert a single prompt section. Invalidates cache. */
export async function upsertPrompt(
  instanceId: InstanceUuid,
  sectionKey: string,
  title: string,
  content: string,
): Promise<void> {
  await db
    .insert(instancePrompts)
    .values({ instanceId, sectionKey, title, content })
    .onConflictDoUpdate({
      target: [instancePrompts.instanceId, instancePrompts.sectionKey],
      set: { title, content, updatedAt: sql`now()` },
    });
  invalidatePromptsCache(instanceId);
}

/**
 * Seed all 8 default prompt sections for an instance.
 * Idempotent: uses ON CONFLICT DO NOTHING on the (instanceId, sectionKey) unique constraint
 * so concurrent calls cannot produce duplicates (no count+insert TOCTOU).
 */
export async function seedInstancePrompts(instanceId: InstanceUuid): Promise<void> {
  await db
    .insert(instancePrompts)
    .values(
      DEFAULT_PROMPTS.map((p) => ({
        instanceId,
        sectionKey: p.sectionKey,
        title: p.title,
        content: p.content,
      })),
    )
    .onConflictDoNothing({ target: [instancePrompts.instanceId, instancePrompts.sectionKey] });
  invalidatePromptsCache(instanceId);
}
