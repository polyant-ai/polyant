// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { DEFAULT_EMBEDDING_DIM } from "../embeddings-gateway/config.js";
import { instances } from "./schema.js";

export interface Instance {
  id: string;
  slug: string;
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
  icon: string | null;
  sttProvider: string;
  embeddingDim: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Return all active instances. */
export async function listActiveInstances(): Promise<Instance[]> {
  return db.select().from(instances).where(eq(instances.status, "active"));
}

/** Find an instance by slug. Returns undefined if not found. */
export async function findInstanceBySlug(slug: string): Promise<Instance | undefined> {
  const rows = await db.select().from(instances).where(eq(instances.slug, slug)).limit(1);
  return rows[0];
}

/** Find an instance by id (UUID). Returns undefined if not found. */
export async function findInstanceById(id: string): Promise<Instance | undefined> {
  const rows = await db.select().from(instances).where(eq(instances.id, id)).limit(1);
  return rows[0];
}

/** Insert an instance if the slug doesn't already exist. */
export async function ensureInstance(data: {
  slug: string;
  name: string;
  description?: string;
}): Promise<void> {
  await db
    .insert(instances)
    .values({
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      embeddingDim: DEFAULT_EMBEDDING_DIM,
    })
    .onConflictDoNothing({ target: instances.slug });
}

/** Seed the default instances. Call once at startup. */
export async function seedInstances(): Promise<void> {
  await ensureInstance({
    slug: "default",
    name: "Default Assistant",
    description: "Default instance — professional and concise",
  });
  await ensureInstance({
    slug: "creative",
    name: "Creative Assistant",
    description: "Example alternative instance — informal and playful",
  });
  console.log("Instances seeded (default, creative)");
}

/** Return all instances (any status), ordered by name (case-insensitive). */
export async function listAllInstances(): Promise<Instance[]> {
  return db.select().from(instances).orderBy(sql`LOWER(${instances.name})`);
}

/** Create a new instance and return it. */
export async function createInstance(data: {
  slug: string;
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
      // New instances default to 1024d; the DB default (1536) stays for legacy rows.
      embeddingDim: DEFAULT_EMBEDDING_DIM,
    })
    .returning();
  return rows[0];
}

/** Update an instance by slug. Touches updatedAt. Returns the updated instance or undefined if not found. */
export async function updateInstance(
  slug: string,
  data: { name?: string; description?: string | null; status?: string; provider?: string | null; model?: string | null; memoryEnabled?: boolean; knowledgeEnabled?: boolean; langsmithEnabled?: boolean; langsmithProject?: string | null; authEnabled?: boolean; thinkingEnabled?: boolean; icon?: string | null; sttProvider?: string },
): Promise<Instance | undefined> {
  const rows = await db
    .update(instances)
    .set({ ...data, updatedAt: sql`now()` })
    .where(eq(instances.slug, slug))
    .returning();
  return rows[0];
}

/** Delete an instance by slug. Returns true if a row was deleted. */
export async function deleteInstance(slug: string): Promise<boolean> {
  const result = await db.delete(instances).where(eq(instances.slug, slug)).returning();
  return result.length > 0;
}
