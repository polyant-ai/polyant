// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { contactOptouts } from "./optout.schema.js";
import { resolveInstanceId } from "../instances/resolve-instance-id.js";
import { asInstanceSlug, type InstanceSlug, type InstanceUuid } from "../instances/identifiers.js";
import { TtlCache } from "../utils/ttl-cache.js";
import type { OptoutStatus } from "./optout.types.js";

type StatusLoader = (
  instanceSlug: string,
  channelType: string,
  channelId: string,
) => Promise<OptoutStatus>;

/**
 * Hot-path status cache keyed by `${slug}:${channel}:${id}`. Checked on every
 * inbound message and every proactive outbound send. Short TTL + explicit
 * invalidation on write. The loader seam keeps it unit-testable without a DB.
 */
export class OptoutStatusCache {
  private readonly cache = new TtlCache<string, OptoutStatus>({ maxSize: 5000, ttlMs: 30_000 });
  constructor(private readonly loader: StatusLoader) {}

  private key(slug: string, channelType: string, channelId: string): string {
    return `${slug}:${channelType}:${channelId}`;
  }

  async get(slug: string, channelType: string, channelId: string): Promise<OptoutStatus> {
    const k = this.key(slug, channelType, channelId);
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    const status = await this.loader(slug, channelType, channelId);
    this.cache.set(k, status);
    return status;
  }

  invalidate(slug: string, channelType: string, channelId: string): void {
    this.cache.delete(this.key(slug, channelType, channelId));
  }
}

/** DB loader: a contact with no row is subscribed (opted_in). */
async function loadStatusFromDb(
  instanceSlug: string,
  channelType: string,
  channelId: string,
): Promise<OptoutStatus> {
  const instanceId = await resolveInstanceId(asInstanceSlug(instanceSlug));
  if (!instanceId) return "opted_in";
  const rows = await db
    .select({ status: contactOptouts.status })
    .from(contactOptouts)
    .where(
      and(
        eq(contactOptouts.instanceId, instanceId),
        eq(contactOptouts.channelType, channelType),
        eq(contactOptouts.channelId, channelId),
      ),
    )
    .limit(1);
  return (rows[0]?.status as OptoutStatus) ?? "opted_in";
}

const statusCache = new OptoutStatusCache(loadStatusFromDb);

/** Resolve the current opt-out status for a contact (cached). */
export async function getOptoutStatus(
  instanceSlug: InstanceSlug,
  channelType: string,
  channelId: string,
): Promise<OptoutStatus> {
  return statusCache.get(instanceSlug, channelType, channelId);
}

/** Upsert the status for a contact and invalidate the cache. */
export async function setOptoutStatus(args: {
  instanceId: InstanceUuid;
  instanceSlug: InstanceSlug;
  channelType: string;
  channelId: string;
  status: OptoutStatus;
  source: "user" | "admin";
}): Promise<void> {
  await db
    .insert(contactOptouts)
    .values({
      instanceId: args.instanceId,
      channelType: args.channelType,
      channelId: args.channelId,
      status: args.status,
      source: args.source,
    })
    .onConflictDoUpdate({
      target: [contactOptouts.instanceId, contactOptouts.channelType, contactOptouts.channelId],
      set: { status: args.status, source: args.source, updatedAt: sql`now()` },
    });
  statusCache.invalidate(args.instanceSlug, args.channelType, args.channelId);
}

export interface OptoutContactRow {
  channelType: string;
  channelId: string;
  status: OptoutStatus;
  source: string;
  updatedAt: Date | null;
}

/** Paginated list of opt-out rows for an instance (admin UI), default opted_out only. */
export async function listOptouts(
  instanceId: InstanceUuid,
  opts: { status?: OptoutStatus; limit?: number; offset?: number } = {},
): Promise<OptoutContactRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const where = opts.status
    ? and(eq(contactOptouts.instanceId, instanceId), eq(contactOptouts.status, opts.status))
    : eq(contactOptouts.instanceId, instanceId);
  const rows = await db
    .select({
      channelType: contactOptouts.channelType,
      channelId: contactOptouts.channelId,
      status: contactOptouts.status,
      source: contactOptouts.source,
      updatedAt: contactOptouts.updatedAt,
    })
    .from(contactOptouts)
    .where(where)
    .orderBy(desc(contactOptouts.updatedAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({ ...r, status: r.status as OptoutStatus }));
}
