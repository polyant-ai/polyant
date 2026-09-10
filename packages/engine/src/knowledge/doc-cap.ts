// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { config } from "../config.js";
import { instances } from "../instances/schema.js";
import type { InstanceSlug } from "../instances/identifiers.js";
import { organizations, workspaces } from "../organizations/organization.schema.js";

/**
 * How many knowledge documents ONE agent may hold, and the only place that
 * question is answered.
 *
 * The cap is per-AGENT and was configured per-DEPLOYMENT
 * (`KNOWLEDGE_MAX_DOCS_PER_INSTANCE`), which is the mismatch this resolves: two
 * organizations sharing one installation could not be told apart, and raising
 * the cap for one customer was a redeploy for all of them. It is now an
 * entitlement on the organization, with the env var as the default for the
 * organizations that declare none.
 *
 * A default, NOT a ceiling. An entitlement that could only ever be lowered from
 * a value baked into the environment would still need a redeploy to sell, which
 * is the thing being fixed.
 *
 * FAILS CLOSED on an agent that cannot be resolved — a slug with no row, or a
 * row whose workspace is gone — by answering the deployment default rather than
 * "no limit". The alternative reading of an unresolvable agent is unlimited
 * writes, which is the wrong direction for a cap.
 */
export async function resolveKnowledgeDocCap(instanceId: InstanceSlug): Promise<number> {
  const rows = await db
    .select({ cap: organizations.knowledgeMaxDocsPerAgent })
    .from(instances)
    .innerJoin(workspaces, eq(instances.workspaceId, workspaces.id))
    .innerJoin(organizations, eq(workspaces.organizationId, organizations.id))
    .where(eq(instances.slug, instanceId))
    .limit(1);

  return rows[0]?.cap ?? config.knowledge.maxDocsPerInstance;
}
