// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database/client.js";
import { agentChannels } from "./channels.schema.js";
import { encrypt, decrypt } from "../crypto/index.js";
import { resolveAgentId } from "./resolve-agent-id.js";
import { type AgentSlug, type AgentUuid } from "./identifiers.js";

/**
 * API-configurable channel types — narrow/closed set.
 *
 * Each entry here has a row in `instance_channels`, a config schema in
 * `channelConfigSchemas` below, and is exposed via the management API
 * (`PUT/DELETE /api/instances/:slug/channels/:type`).
 *
 * NOT the same as `MessageChannelType` in `channels/types.ts`, which is the
 * WIDE set covering every possible provenance of a pipeline message
 * (additionally includes `web`, `scheduled`, `room` which have no
 * per-instance stored credentials and are not API-configurable).
 *
 * Adding a new API-configurable channel:
 *   1. Append the literal to this tuple.
 *   2. Add a Zod schema entry below.
 *   3. Wire a case in `channel-manager.ts:createAdapter`.
 *   4. `MessageChannelType` widens automatically.
 *   5. Update any test mocks that hardcode this tuple.
 */
export const CHANNEL_TYPES = ["telegram", "slack", "whatsapp", "agent"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** Safely decrypt channel config. Returns empty object if config is empty/invalid. */
function safeDecryptConfig(encrypted: string): Record<string, unknown> {
  if (!encrypted || !encrypted.includes(":")) return {};
  try {
    return JSON.parse(decrypt(encrypted)) as Record<string, unknown>;
  } catch (err) {
    console.error("[Channels] Failed to decrypt channel config:", err);
    return {};
  }
}

/** Zod schemas for channel-specific config validation. */
export const channelConfigSchemas: Record<ChannelType, z.ZodType> = {
  telegram: z.object({
    botToken: z.string().min(1),
    allowedUserIds: z.string().optional(),
  }),
  slack: z.object({
    botToken: z.string().min(1),
    appToken: z.string().min(1),
    signingSecret: z.string().min(1),
  }),
  whatsapp: z.object({
    accountSid: z.string().min(1),
    authToken: z.string().min(1),
    whatsappNumber: z.string().regex(/^\+\d+$/),
  }),
  /**
   * Virtual in-process channel for agent-to-agent invocation. No external
   * credentials: enabling the row is the toggle that makes this instance
   * callable from other agents via the supervisor's `agent:{slug}` tool.
   * The config payload is intentionally open-passthrough — future per-pair
   * policies (allowed callers, default timeouts) can land here without a
   * schema migration.
   */
  agent: z.object({}).passthrough(),
};

export interface ChannelConfig {
  channelType: ChannelType;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** Set or update a channel config for an instance (by UUID). */
export async function setChannelConfig(
  agentId: AgentUuid,
  channelType: ChannelType,
  config: Record<string, unknown>,
  enabled: boolean,
): Promise<void> {
  // Validate config against channel schema
  const schema = channelConfigSchemas[channelType];
  schema.parse(config);

  const encryptedConfig = encrypt(JSON.stringify(config));

  await db
    .insert(agentChannels)
    .values({ agentId, channelType, enabled, config: encryptedConfig })
    .onConflictDoUpdate({
      target: [agentChannels.agentId, agentChannels.channelType],
      set: { enabled, config: encryptedConfig, updatedAt: new Date() },
    });
}

/** Get a single channel config for an instance (by slug). */
export async function getChannelConfig(
  instanceSlug: AgentSlug,
  channelType: ChannelType,
): Promise<ChannelConfig | null> {
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return null;

  const rows = await db
    .select({
      channelType: agentChannels.channelType,
      enabled: agentChannels.enabled,
      config: agentChannels.config,
    })
    .from(agentChannels)
    .where(and(eq(agentChannels.agentId, agentId), eq(agentChannels.channelType, channelType)))
    .limit(1);

  if (!rows[0]) return null;

  return {
    channelType: rows[0].channelType as ChannelType,
    enabled: rows[0].enabled,
    config: safeDecryptConfig(rows[0].config),
  };
}

/** List all channel configs for an instance (by slug). */
export async function listChannelConfigs(instanceSlug: AgentSlug): Promise<ChannelConfig[]> {
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return [];

  const rows = await db
    .select({
      channelType: agentChannels.channelType,
      enabled: agentChannels.enabled,
      config: agentChannels.config,
    })
    .from(agentChannels)
    .where(eq(agentChannels.agentId, agentId));

  return rows.map((row) => ({
    channelType: row.channelType as ChannelType,
    enabled: row.enabled,
    config: safeDecryptConfig(row.config),
  }));
}

/** List all enabled channel configs for an instance (by slug). */
export async function listEnabledChannelConfigs(instanceSlug: AgentSlug): Promise<ChannelConfig[]> {
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return [];

  const rows = await db
    .select({
      channelType: agentChannels.channelType,
      enabled: agentChannels.enabled,
      config: agentChannels.config,
    })
    .from(agentChannels)
    .where(and(eq(agentChannels.agentId, agentId), eq(agentChannels.enabled, true)));

  return rows.map((row) => ({
    channelType: row.channelType as ChannelType,
    enabled: row.enabled,
    config: safeDecryptConfig(row.config),
  }));
}

/** Disable a channel by slug + type (used by auto-disable on adapter failure). */
export async function disableChannel(instanceSlug: AgentSlug, channelType: string): Promise<void> {
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return;
  await db
    .update(agentChannels)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(agentChannels.agentId, agentId), eq(agentChannels.channelType, channelType)));
}

/** Delete a channel config by instance UUID + channel type. */
export async function deleteChannelConfig(agentId: AgentUuid, channelType: ChannelType): Promise<void> {
  await db
    .delete(agentChannels)
    .where(and(eq(agentChannels.agentId, agentId), eq(agentChannels.channelType, channelType)));
}
