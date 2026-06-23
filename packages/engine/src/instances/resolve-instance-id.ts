// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "./schema.js";
import { findInstanceById, findInstanceBySlug } from "./store.js";
import type { Instance } from "./store.js";

/** Resolve an instance slug to its UUID. */
export async function resolveInstanceId(slug: string): Promise<string | undefined> {
  const rows = await db
    .select({ id: instances.id })
    .from(instances)
    .where(eq(instances.slug, slug))
    .limit(1);
  return rows[0]?.id;
}

/** Resolve an instance UUID to its slug. */
export async function resolveInstanceSlug(instanceId: string): Promise<string | undefined> {
  const rows = await db
    .select({ slug: instances.slug })
    .from(instances)
    .where(eq(instances.id, instanceId))
    .limit(1);
  return rows[0]?.slug;
}

/**
 * Resolve an instance by either its UUID or its slug. Tries id first when the
 * value looks like a UUID, otherwise slug; falls back to the other form so a
 * caller passing either alias always succeeds. Returns undefined if not found.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function findInstanceByIdOrSlug(idOrSlug: string): Promise<Instance | undefined> {
  if (UUID_RE.test(idOrSlug)) {
    return (await findInstanceById(idOrSlug)) ?? (await findInstanceBySlug(idOrSlug));
  }
  return (await findInstanceBySlug(idOrSlug)) ?? (await findInstanceById(idOrSlug));
}
