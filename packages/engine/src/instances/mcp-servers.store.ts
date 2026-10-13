// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database/client.js";
import { instanceMcpServers } from "./mcp-servers.schema.js";
import { encrypt, decrypt } from "../crypto/index.js";
import { isSafeMcpUrl } from "../agents/tools/mcp/mcp-url-guard.js";
import { type InstanceUuid } from "./identifiers.js";

/**
 * `none` is a real mode, not the absence of one: plenty of MCP servers are public
 * or sit behind network isolation and want no credential at all. Making it
 * explicit means the panel never asks for a token it will not use, and the
 * config schema can REFUSE one — an unused secret stored at rest is a liability,
 * not a convenience.
 */
export const MCP_AUTH_MODES = ["none", "static", "oauth"] as const;
export type McpAuthMode = (typeof MCP_AUTH_MODES)[number];

// No credential to carry. `allowList` still applies — which tools an agent may
// call is a separate question from how it authenticates. `.strict()` so a token
// sent by mistake is a 400 rather than a secret silently persisted.
const noneConfigSchema = z.object({
  allowList: z.array(z.string()).optional(),
}).strict();

const staticConfigSchema = z.object({
  auth: z.union([
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
    z.object({ type: z.literal("header"), headerName: z.string().min(1), token: z.string().min(1) }),
  ]),
  allowList: z.array(z.string()).optional(),
});

/**
 * An endpoint the OAuth flow will REQUEST. `server.url` gets the SSRF guard, so
 * these have to as well: they steer the very same client, and a config field is
 * written once and read on every turn. The check is literal-only (no DNS) —
 * `assertSafeMcpUrlResolved` is the connection path's job.
 */
const safeOAuthEndpoint = z
  .string()
  .refine(isSafeMcpUrl, "must be an http(s) URL that is not a private, loopback or metadata host");

/**
 * The DCR (RFC 7591) registration response, written back by the SDK through
 * `saveClientInformation`. Spelled out rather than `z.record(z.unknown())`: an
 * open record made the schema a pass-through, so an import bundle could seed a
 * fabricated `dcrClient` — which `clientInformation()` PREFERS over
 * `staticClient` — and point its three endpoint fields anywhere. Unknown keys
 * are stripped (zod's default), which is what the comment in
 * `mcp-servers.import.ts` promises.
 */
const dcrClientSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  issuer: safeOAuthEndpoint.optional(),
  authorization_server: safeOAuthEndpoint.optional(),
  token_endpoint: safeOAuthEndpoint.optional(),
});

/** The authorization-server metadata the SDK caches through `saveAuthorizationServerInformation`. */
const authServerInfoSchema = z.object({
  // `issuer` is an identifier, not something we request — validated as a
  // non-empty string, not as a reachable endpoint.
  issuer: z.string().min(1).optional(),
  authorizationServerUrl: safeOAuthEndpoint,
  tokenEndpoint: safeOAuthEndpoint,
});

/**
 * Which account an oauth server acts as. `conversation` (the default, and what
 * an absent value means) asks whoever is chatting to authorize, and keeps the
 * token for that conversation only. `shared` uses the one account an admin
 * connected from the panel, for every conversation of the agent.
 */
export const MCP_OAUTH_ACCOUNTS = ["conversation", "shared"] as const;
export type McpOAuthAccount = (typeof MCP_OAUTH_ACCOUNTS)[number];

const oauthConfigSchema = z.object({
  account: z.enum(MCP_OAUTH_ACCOUNTS).optional(),
  scopes: z.array(z.string()).optional(),
  staticClient: z.object({ clientId: z.string().min(1), clientSecret: z.string().optional() }).optional(),
  dcrClient: dcrClientSchema.optional(),
  authServerInfo: authServerInfoSchema.optional(),
  allowList: z.array(z.string()).optional(),
});

export type McpServerConfig =
  | z.infer<typeof noneConfigSchema>
  | z.infer<typeof staticConfigSchema>
  | z.infer<typeof oauthConfigSchema>;

/** Validate a config blob against its auth mode; throws ZodError on mismatch. */
export function mcpServerConfigSchema(authMode: McpAuthMode, config: unknown): McpServerConfig {
  if (authMode === "none") return noneConfigSchema.parse(config);
  if (authMode === "static") return staticConfigSchema.parse(config);
  return oauthConfigSchema.parse(config);
}

export interface McpServerRecord {
  id: string;
  slug: string;
  name: string;
  url: string;
  authMode: McpAuthMode;
  enabled: boolean;
  config: McpServerConfig;
  /**
   * When an admin connected the shared account, and who. Null while nothing is
   * connected. The tokens themselves never leave the store through a record.
   */
  sharedAccount: { connectedAt: string; connectedBy: string | null } | null;
}

/** Whether `config` asks for the shared account. Only an oauth config can. */
export function usesSharedAccount(authMode: McpAuthMode, config: McpServerConfig): boolean {
  return authMode === "oauth" && (config as { account?: McpOAuthAccount }).account === "shared";
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
    sharedAccount:
      row.sharedTokens && row.sharedConnectedAt
        ? { connectedAt: row.sharedConnectedAt.toISOString(), connectedBy: row.sharedConnectedBy }
        : null,
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
  // A connected shared account survives an edit only while the server still
  // asks for it at the same address: tokens issued for one server are never
  // presented to another, and a server that stopped using them keeps none.
  const keepShared = usesSharedAccount(input.authMode, validated)
    ? sql`${instanceMcpServers.url} = ${input.url}`
    : sql`false`;
  await db
    .insert(instanceMcpServers)
    .values({ instanceId, slug: input.slug, name: input.name, url: input.url, authMode: input.authMode, enabled: input.enabled, config: encryptedConfig })
    .onConflictDoUpdate({
      target: [instanceMcpServers.instanceId, instanceMcpServers.slug],
      set: {
        name: input.name,
        url: input.url,
        authMode: input.authMode,
        enabled: input.enabled,
        config: encryptedConfig,
        sharedTokens: sql`case when ${keepShared} then ${instanceMcpServers.sharedTokens} end`,
        sharedConnectedAt: sql`case when ${keepShared} then ${instanceMcpServers.sharedConnectedAt} end`,
        sharedConnectedBy: sql`case when ${keepShared} then ${instanceMcpServers.sharedConnectedBy} end`,
        updatedAt: new Date(),
      },
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

/** The shared account's OAuth tokens, decrypted, or null when none is connected. */
export async function getMcpSharedTokens(instanceId: InstanceUuid, slug: string): Promise<string | null> {
  const [row] = await db
    .select({ tokens: instanceMcpServers.sharedTokens })
    .from(instanceMcpServers)
    .where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.slug, slug)));
  return row?.tokens ? decrypt(row.tokens) : null;
}

/**
 * Store the shared account's tokens. `connectedBy` is set when an admin
 * completes a connection, and omitted on a refresh, which keeps who connected
 * and when. A pooled connection reads its tokens through the provider on every
 * request, so a refresh reaches it without a reconnect.
 */
export async function saveMcpSharedTokens(
  instanceId: InstanceUuid,
  slug: string,
  tokens: string,
  connected?: { by: string | null },
): Promise<void> {
  await db
    .update(instanceMcpServers)
    .set({
      sharedTokens: encrypt(tokens),
      ...(connected ? { sharedConnectedAt: new Date(), sharedConnectedBy: connected.by } : {}),
    })
    .where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.slug, slug)));
}

/** Forget the shared account. Returns whether one was connected. */
export async function clearMcpSharedTokens(instanceId: InstanceUuid, slug: string): Promise<boolean> {
  const cleared = await db
    .update(instanceMcpServers)
    .set({ sharedTokens: null, sharedConnectedAt: null, sharedConnectedBy: null })
    .where(
      and(
        eq(instanceMcpServers.instanceId, instanceId),
        eq(instanceMcpServers.slug, slug),
        sql`${instanceMcpServers.sharedTokens} is not null`,
      ),
    )
    .returning({ id: instanceMcpServers.id });
  return cleared.length > 0;
}
