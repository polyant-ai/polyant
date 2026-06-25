// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { agents } from "./schema.js";
import { asAgentUuid, asAgentSlug, type AgentSlug, type AgentUuid } from "./identifiers.js";
import { findInstanceById, findInstanceBySlug, type Agent } from "./store.js";

/** Resolve an instance slug to its UUID. */
export async function resolveAgentId(slug: AgentSlug): Promise<AgentUuid | undefined> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, slug))
    .limit(1);
  return rows[0] ? asAgentUuid(rows[0].id) : undefined;
}

/** Resolve an instance UUID to its slug. */
export async function resolveAgentSlug(agentId: AgentUuid): Promise<AgentSlug | undefined> {
  const rows = await db
    .select({ slug: agents.slug })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows[0] ? asAgentSlug(rows[0].slug) : undefined;
}

/**
 * Resolve an agent by either its UUID or its slug. When the value is
 * UUID-shaped it is looked up by id first (then slug as a defensive fallback);
 * otherwise it is resolved by slug only — a non-UUID-shaped value can never be
 * a UUID primary key. Returns undefined if not found.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function findInstanceByIdOrSlug(idOrSlug: string): Promise<Agent | undefined> {
  if (UUID_RE.test(idOrSlug)) {
    return (await findInstanceById(asAgentUuid(idOrSlug))) ?? (await findInstanceBySlug(asAgentSlug(idOrSlug)));
  }
  return findInstanceBySlug(asAgentSlug(idOrSlug));
}
