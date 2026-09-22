// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { platformSettings } from "./platform-settings.schema.js";

/** The policies as they are STORED: null means "not set, use the deployment default". */
export interface StoredPlatformSettings {
  readonly analyticsRetentionDays: number | null;
  readonly sseMaxConnectionsPerUser: number | null;
}

/** The policies as the code CONSUMES them: resolved, never null. */
export interface EffectivePlatformSettings {
  readonly analyticsRetentionDays: number;
  readonly sseMaxConnectionsPerUser: number;
}

const SINGLE_ROW = true;

/**
 * What each policy is worth when the installation has not set it. These were
 * `ANALYTICS_RETENTION_DAYS` and `SSE_MAX_CONNECTIONS_PER_USER`; once the column
 * existed the variable was a second answer to the same question, reachable only
 * by redeploying, so it is gone and the default sits beside the resolver.
 */
const DEFAULT_ANALYTICS_RETENTION_DAYS = 90;
const DEFAULT_SSE_MAX_CONNECTIONS_PER_USER = 5;

/**
 * A short in-memory cache, because `sseMaxConnectionsPerUser` is read on every
 * activity-stream connect and `analyticsRetentionDays` once a day. Ten seconds
 * is long enough that a burst of connects costs one query and short enough that
 * an administrator who changes a policy sees it take effect while still looking
 * at the page.
 */
const CACHE_TTL_MS = 10_000;

/**
 * The PROMISE is cached, not just the value. Caching the value alone leaves a
 * window where several concurrent callers all miss and all query — which is
 * exactly the shape of the traffic here, a burst of activity-stream connects
 * arriving together.
 */
let cached: { at: number; value: Promise<StoredPlatformSettings> } | null = null;

/** Drop the cache. Called by the write path so a change is visible immediately. */
export function invalidatePlatformSettingsCache(): void {
  cached = null;
}

function readStored(): Promise<StoredPlatformSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  // Stamped and stored BEFORE awaiting, so a second caller arriving mid-flight
  // joins this read instead of starting its own. A rejection clears the entry,
  // so a failed read is retried rather than cached for ten seconds.
  const value = fetchStored().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  cached = { at: Date.now(), value };
  return value;
}

async function fetchStored(): Promise<StoredPlatformSettings> {
  const rows = await db
    .select({
      analyticsRetentionDays: platformSettings.analyticsRetentionDays,
      sseMaxConnectionsPerUser: platformSettings.sseMaxConnectionsPerUser,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, SINGLE_ROW))
    .limit(1);

  // The migration seeds the row, so an absent one means a database that has not
  // been migrated. Both policies read as unset, which is the deployment default
  // — the behaviour every installation had before this table existed.
  return (
    rows[0] ?? {
      analyticsRetentionDays: null,
      sseMaxConnectionsPerUser: null,
    }
  );
}

/** What is stored, for the page that edits it: unset must stay visible as unset. */
export async function getStoredPlatformSettings(): Promise<StoredPlatformSettings> {
  return readStored();
}

/**
 * The policies in force, and the only place the fallback is applied.
 *
 * Each value is the stored one when the installation set it, and the constant
 * above when it did not.
 */
export async function resolvePlatformSettings(): Promise<EffectivePlatformSettings> {
  const stored = await readStored();
  return {
    analyticsRetentionDays: stored.analyticsRetentionDays ?? DEFAULT_ANALYTICS_RETENTION_DAYS,
    sseMaxConnectionsPerUser: stored.sseMaxConnectionsPerUser ?? DEFAULT_SSE_MAX_CONNECTIONS_PER_USER,
  };
}

/**
 * Write the policies. `null` CLEARS one back to the deployment default, which is
 * why the fields are nullable rather than optional: omitting a field leaves it
 * alone, and passing null is a decision.
 */
export async function updatePlatformSettings(
  patch: Partial<StoredPlatformSettings>,
  updatedBy: string | undefined,
): Promise<StoredPlatformSettings> {
  await db
    .update(platformSettings)
    .set({ ...patch, updatedAt: new Date(), updatedBy: updatedBy ?? null })
    .where(eq(platformSettings.id, SINGLE_ROW));
  invalidatePlatformSettingsCache();
  return readStored();
}
