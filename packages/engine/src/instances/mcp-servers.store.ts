// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database/client.js";
import { instanceMcpServers } from "./mcp-servers.schema.js";
import { encrypt, decrypt } from "../crypto/index.js";
import { type InstanceUuid } from "./identifiers.js";

export const MCP_AUTH_MODES = ["static", "oauth"] as const;
export type McpAuthMode = (typeof MCP_AUTH_MODES)[number];

const staticConfigSchema = z.object({
  auth: z.union([
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
    z.object({ type: z.literal("header"), headerName: z.string().min(1), token: z.string().min(1) }),
  ]),
  allowList: z.array(z.string()).optional(),
});

const oauthConfigSchema = z.object({
  scopes: z.array(z.string()).optional(),
  staticClient: z.object({ clientId: z.string().min(1), clientSecret: z.string().optional() }).optional(),
  dcrClient: z.record(z.unknown()).optional(),
  allowList: z.array(z.string()).optional(),
});

export type McpServerConfig = z.infer<typeof staticConfigSchema> | z.infer<typeof oauthConfigSchema>;

/** Validate a config blob against its auth mode; throws ZodError on mismatch. */
export function mcpServerConfigSchema(authMode: McpAuthMode, config: unknown): McpServerConfig {
  return authMode === "static" ? staticConfigSchema.parse(config) : oauthConfigSchema.parse(config);
}

export interface McpServerRecord {
  id: string;
  slug: string;
  name: string;
  url: string;
  authMode: McpAuthMode;
  enabled: boolean;
  config: McpServerConfig;
}

function decryptConfig(encrypted: string): Record<string, unknown> {
  if (!encrypted || !encrypted.includes(":")) return {};
  try {
    return JSON.parse(decrypt(encrypted)) as Record<string, unknown>;
  } catch (err) {
    console.error("[McpServers] Failed to decrypt config:", err);
    return {};
  }
}

function toRecord(row: typeof instanceMcpServers.$inferSelect): McpServerRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    authMode: row.authMode as McpAuthMode,
    enabled: row.enabled,
    config: decryptConfig(row.config) as McpServerConfig,
  };
}

export interface SetMcpServerInput {
  slug: string;
  name: string;
  url: string;
  authMode: McpAuthMode;
  enabled: boolean;
  config: Record<string, unknown>;
}

export async function setMcpServer(instanceId: InstanceUuid, input: SetMcpServerInput): Promise<void> {
  const validated = mcpServerConfigSchema(input.authMode, input.config); // strips unknown keys before persisting
  const encryptedConfig = encrypt(JSON.stringify(validated));
  await db
    .insert(instanceMcpServers)
    .values({ instanceId, slug: input.slug, name: input.name, url: input.url, authMode: input.authMode, enabled: input.enabled, config: encryptedConfig })
    .onConflictDoUpdate({
      target: [instanceMcpServers.instanceId, instanceMcpServers.slug],
      set: { name: input.name, url: input.url, authMode: input.authMode, enabled: input.enabled, config: encryptedConfig, updatedAt: new Date() },
    });
}

export async function getMcpServer(instanceId: InstanceUuid, slug: string): Promise<McpServerRecord | null> {
  const rows = await db.select().from(instanceMcpServers).where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.slug, slug)));
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listMcpServers(instanceId: InstanceUuid): Promise<McpServerRecord[]> {
  const rows = await db.select().from(instanceMcpServers).where(eq(instanceMcpServers.instanceId, instanceId));
  return rows.map(toRecord);
}

export async function listEnabledMcpServers(instanceId: InstanceUuid): Promise<McpServerRecord[]> {
  const rows = await db.select().from(instanceMcpServers).where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.enabled, true)));
  return rows.map(toRecord);
}

export async function deleteMcpServer(instanceId: InstanceUuid, slug: string): Promise<void> {
  await db.delete(instanceMcpServers).where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.slug, slug)));
}

/** Read-modify-write of the encrypted config (used to persist DCR client info). */
export async function mergeMcpServerConfig(instanceId: InstanceUuid, slug: string, patch: Record<string, unknown>): Promise<void> {
  const current = await getMcpServer(instanceId, slug);
  if (!current) return;
  const merged = mcpServerConfigSchema(current.authMode, { ...(current.config as Record<string, unknown>), ...patch });
  await db
    .update(instanceMcpServers)
    .set({ config: encrypt(JSON.stringify(merged)), updatedAt: new Date() })
    .where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.slug, slug)));
}
