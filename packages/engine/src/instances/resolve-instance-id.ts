// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "./schema.js";
import { asInstanceUuid, asInstanceSlug, type InstanceSlug, type InstanceUuid } from "./identifiers.js";

/** Resolve an instance slug to its UUID. */
export async function resolveInstanceId(slug: InstanceSlug): Promise<InstanceUuid | undefined> {
  const rows = await db
    .select({ id: instances.id })
    .from(instances)
    .where(eq(instances.slug, slug))
    .limit(1);
  return rows[0] ? asInstanceUuid(rows[0].id) : undefined;
}

/** Resolve an instance UUID to its slug. */
export async function resolveInstanceSlug(instanceId: InstanceUuid): Promise<InstanceSlug | undefined> {
  const rows = await db
    .select({ slug: instances.slug })
    .from(instances)
    .where(eq(instances.id, instanceId))
    .limit(1);
  return rows[0] ? asInstanceSlug(rows[0].slug) : undefined;
}
