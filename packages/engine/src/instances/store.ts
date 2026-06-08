// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, sql, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "./schema.js";
import { conversations, conversationMessages, conversationState } from "../conversations/schema.js";
import { memories } from "../memory/schema.js";
import { knowledgeDocuments } from "../knowledge/schema.js";
import { scheduledTasks } from "../scheduled-tasks/schema.js";
import { asInstanceSlug, asInstanceUuid, type InstanceSlug, type InstanceUuid } from "./identifiers.js";

export interface Instance {
  id: InstanceUuid;
  slug: InstanceSlug;
  name: string;
  description: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  memoryEnabled: boolean;
  knowledgeEnabled: boolean;
  langsmithEnabled: boolean;
  langsmithProject: string | null;
  authEnabled: boolean;
  /**
   * Persisted user preference: enable extended thinking on the model.
   *
   * The field is stored as-is across model changes; the runtime config-resolver
   * gates it behind `isThinkingCapable(provider, model)` so a stale `true`
   * after switching to a non-capable model has no effect.
   */
  thinkingEnabled: boolean;
  /** When true, the conversation state store is rendered read-only into the system prompt. */
  stateInPromptEnabled: boolean;
  icon: string | null;
  sttProvider: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

function toInstance(row: typeof instances.$inferSelect): Instance {
  return { ...row, id: asInstanceUuid(row.id), slug: asInstanceSlug(row.slug) } as Instance;
}

/** Return all active instances. */
export async function listActiveInstances(): Promise<Instance[]> {
  return db.select().from(instances).where(eq(instances.status, "active")).then((rows) => rows.map(toInstance));
}

/** Find an instance by slug. Returns undefined if not found. */
export async function findInstanceBySlug(slug: InstanceSlug): Promise<Instance | undefined> {
  const rows = await db.select().from(instances).where(eq(instances.slug, slug)).limit(1);
  return rows[0] ? toInstance(rows[0]) : undefined;
}

/** Insert an instance if the slug doesn't already exist. */
export async function ensureInstance(data: {
  slug: InstanceSlug;
  name: string;
  description?: string;
}): Promise<void> {
  await db
    .insert(instances)
    .values({
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
    })
    .onConflictDoNothing({ target: instances.slug });
}

/** Seed the default instances. Call once at startup. */
export async function seedInstances(): Promise<void> {
  await ensureInstance({
    slug: asInstanceSlug("default"),
    name: "Default Assistant",
    description: "Default instance — professional and concise",
  });
  await ensureInstance({
    slug: asInstanceSlug("creative"),
    name: "Creative Assistant",
    description: "Example alternative instance — informal and playful",
  });
  console.log("Instances seeded (default, creative)");
}

/** Return all instances (any status), ordered by name (case-insensitive). */
export async function listAllInstances(): Promise<Instance[]> {
  return db.select().from(instances).orderBy(sql`LOWER(${instances.name})`).then((rows) => rows.map(toInstance));
}

/** Create a new instance and return it. */
export async function createInstance(data: {
  slug: InstanceSlug;
  name: string;
  description?: string;
  provider?: string;
  model?: string;
}): Promise<Instance> {
  const rows = await db
    .insert(instances)
    .values({
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      provider: data.provider ?? null,
      model: data.model ?? null,
    })
    .returning();
  return toInstance(rows[0]);
}

/** Update an instance by slug. Touches updatedAt. Returns the updated instance or undefined if not found. */
export async function updateInstance(
  slug: InstanceSlug,
  data: { name?: string; description?: string | null; status?: string; provider?: string | null; model?: string | null; memoryEnabled?: boolean; knowledgeEnabled?: boolean; langsmithEnabled?: boolean; langsmithProject?: string | null; authEnabled?: boolean; thinkingEnabled?: boolean; icon?: string | null; sttProvider?: string },
): Promise<Instance | undefined> {
  const rows = await db
    .update(instances)
    .set({ ...data, updatedAt: sql`now()` })
    .where(eq(instances.slug, slug))
    .returning();
  return rows[0] ? toInstance(rows[0]) : undefined;
}

/**
 * Delete an instance by slug. Returns true if a row was deleted.
 *
 * Runs in a transaction. Operational/PII data is keyed by the instance SLUG in
 * `text` columns with no FK to `instances`, so the DB cascade never reaches it —
 * it must be deleted explicitly here. Config/lifecycle tables (secrets, channels,
 * prompts, tools, skills, room, webhooks) use a `uuid` FK with ON DELETE CASCADE
 * and are cleaned up automatically by the final `DELETE FROM instances`.
 *
 * Audit/telemetry (`tool_audit_logs`, `pipeline_traces`, `ai_logs`) is
 * INTENTIONALLY PRESERVED as a historical record and is left untouched.
 */
export async function deleteInstance(slug: InstanceSlug): Promise<boolean> {
  return db.transaction(async (tx) => {
    // conversation_messages has no instance_id — delete via the instance's conversations.
    const convRows = await tx
      .select({ conversationId: conversations.conversationId })
      .from(conversations)
      .where(eq(conversations.instanceId, slug));
    const convIds = convRows.map((r) => r.conversationId);
    if (convIds.length > 0) {
      await tx
        .delete(conversationMessages)
        .where(inArray(conversationMessages.conversationId, convIds));
    }
    await tx.delete(conversations).where(eq(conversations.instanceId, slug));
    await tx.delete(memories).where(eq(memories.instanceId, slug));
    // knowledge_chunks cascade via their document_id FK.
    await tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.instanceId, slug));
    // scheduled_task_runs cascade via their task_id FK.
    await tx.delete(scheduledTasks).where(eq(scheduledTasks.instanceId, slug));
    // conversation_state is slug-keyed operational/PII data — drop it too.
    await tx.delete(conversationState).where(eq(conversationState.instanceId, slug));

    const result = await tx.delete(instances).where(eq(instances.slug, slug)).returning();
    return result.length > 0;
  });
}
