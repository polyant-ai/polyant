// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../database/client.js";
import { platformSettings } from "./platform-settings.schema.js";

/** The numeric policies, named once so the three shapes below cannot drift apart. */
export const PLATFORM_SETTING_NUMBERS = [
  "analyticsRetentionDays",
  "sseMaxConnections",
  "sseMaxConnectionsPerUser",
  "throttleTtlMs",
  "throttleLimit",
  "agentCallTimeoutMs",
  "mcpConnectTimeoutMs",
  "schedulerOrphanGraceMs",
  "schedulerDefaultMaxRunMs",
] as const;

export type PlatformSettingNumber = (typeof PLATFORM_SETTING_NUMBERS)[number];

/** The policies as they are STORED: null means "not set, use the shipped default". */
export type StoredPlatformSettings = {
  readonly [K in PlatformSettingNumber]: number | null;
} & {
  readonly baseUrl: string | null;
};

/** The policies as the code CONSUMES them: resolved, never null. */
export type EffectivePlatformSettings = {
  readonly [K in PlatformSettingNumber]: number;
} & {
  readonly baseUrl: string;
};

const SINGLE_ROW = true;

/**
 * What each policy is worth when the installation has not set it. Every one of
 * them used to be an environment variable; once the column existed the variable
 * was a second answer to the same question, reachable only by redeploying, so
 * the variable is gone and the default sits beside the resolver that applies it.
 *
 * `baseUrl` is the exception and keeps `BASE_URL` behind it: the engine has to
 * be able to name itself on a first boot, before any administrator has opened
 * the panel. `config.server.baseUrl` is that value, already resolved to
 * `http://localhost:<port>` when nothing is set.
 */
const DEFAULTS: { readonly [K in PlatformSettingNumber]: number } = {
  analyticsRetentionDays: 90,
  sseMaxConnections: 50,
  sseMaxConnectionsPerUser: 5,
  throttleTtlMs: 60_000,
  throttleLimit: 30,
  agentCallTimeoutMs: 60_000,
  mcpConnectTimeoutMs: 10_000,
  schedulerOrphanGraceMs: 15 * 60_000,
  schedulerDefaultMaxRunMs: 30 * 60_000,
};

/**
 * A short in-memory cache, because the rate limit is read on every request and
 * `analyticsRetentionDays` once a day. Ten seconds
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

/** Every policy unset: what an unmigrated database and a missing row both mean. */
const NOTHING_STORED: StoredPlatformSettings = {
  ...(Object.fromEntries(PLATFORM_SETTING_NUMBERS.map((key) => [key, null])) as {
    [K in PlatformSettingNumber]: null;
  }),
  baseUrl: null,
};

async function fetchStored(): Promise<StoredPlatformSettings> {
  const rows = await db
    .select({
      analyticsRetentionDays: platformSettings.analyticsRetentionDays,
      sseMaxConnections: platformSettings.sseMaxConnections,
      sseMaxConnectionsPerUser: platformSettings.sseMaxConnectionsPerUser,
      throttleTtlMs: platformSettings.throttleTtlMs,
      throttleLimit: platformSettings.throttleLimit,
      agentCallTimeoutMs: platformSettings.agentCallTimeoutMs,
      mcpConnectTimeoutMs: platformSettings.mcpConnectTimeoutMs,
      schedulerOrphanGraceMs: platformSettings.schedulerOrphanGraceMs,
      schedulerDefaultMaxRunMs: platformSettings.schedulerDefaultMaxRunMs,
      baseUrl: platformSettings.baseUrl,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, SINGLE_ROW))
    .limit(1);

  // The migration seeds the row, so an absent one means a database that has not
  // been migrated. Every policy reads as unset, which is the shipped behaviour —
  // what every installation had before this table existed.
  return rows[0] ?? NOTHING_STORED;
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
  const numbers = Object.fromEntries(
    PLATFORM_SETTING_NUMBERS.map((key) => [key, stored[key] ?? DEFAULTS[key]]),
  ) as { [K in PlatformSettingNumber]: number };
  return { ...numbers, baseUrl: stored.baseUrl ?? config.server.baseUrl };
}

/**
 * The same policies for a caller that cannot afford to fail: a read that throws
 * becomes the shipped defaults instead of the caller's error.
 *
 * It exists for the rate limiter, which resolves a limit on EVERY request. A
 * database blip there would turn one unavailable table into a 500 on every
 * route, including the panel page an administrator would use to look into it.
 * Falling back to the shipped limit is the reading that keeps the deployment
 * answering while it is degraded.
 */
export async function resolvePlatformSettingsOrDefaults(): Promise<EffectivePlatformSettings> {
  try {
    return await resolvePlatformSettings();
  } catch (err: unknown) {
    console.warn(
      `[platform-settings] falling back to the shipped defaults: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...DEFAULTS, baseUrl: config.server.baseUrl };
  }
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
