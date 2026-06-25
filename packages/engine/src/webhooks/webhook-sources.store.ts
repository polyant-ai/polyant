// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database/client.js";
import { eventSources, eventDefinitions } from "./webhooks.schema.js";
import { encrypt, decrypt, generateToken } from "../crypto/index.js";
import { resolveAgentId } from "../instances/resolve-agent-id.js";
import { asAgentUuid, type AgentSlug, type AgentUuid } from "../instances/identifiers.js";
import { webhookLog } from "./webhook-logger.js";

export interface EventSource {
  id: string;
  agentId: AgentUuid;
  name: string;
  sourceType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  webhookToken: string;
  createdAt: Date | null;
}

export interface EventDefinition {
  id: string;
  eventSourceId: string;
  name: string;
  matchingPrompt: string;
  interpretationPrompt: string;
  action: string;
  contextPrompt: string | null;
  outboundChannel: string | null;
  outboundTarget: string | null;
  enabled: boolean;
}

export const eventSourceConfigSchemas: Record<string, z.ZodType> = {
  hubspot: z.object({
    clientSecret: z.string().min(1),
  }),
};

function generateWebhookToken(): string {
  return generateToken(32);
}

export async function listEventSources(slug: AgentSlug): Promise<EventSource[]> {
  const agentId = await resolveAgentId(slug);
  if (!agentId) return [];

  const rows = await db
    .select()
    .from(eventSources)
    .where(eq(eventSources.agentId, agentId));

  return rows.map((r) => {
    try {
      return { ...r, agentId: asAgentUuid(r.agentId), config: JSON.parse(decrypt(r.config)) as Record<string, unknown> };
    } catch {
      webhookLog.warn("WebhookSources", `failed to decrypt config for source ${r.id}, using empty config`);
      return { ...r, agentId: asAgentUuid(r.agentId), config: {} as Record<string, unknown> };
    }
  });
}

export interface EventSourceWithDefinitions extends EventSource {
  definitions: EventDefinition[];
}

export async function listEventSourcesWithDefinitions(slug: AgentSlug): Promise<EventSourceWithDefinitions[]> {
  const sources = await listEventSources(slug);
  if (sources.length === 0) return [];

  const sourceIds = sources.map((s) => s.id);
  const allDefs = await db
    .select()
    .from(eventDefinitions)
    .where(inArray(eventDefinitions.eventSourceId, sourceIds));

  const defsBySource = new Map<string, EventDefinition[]>();
  for (const def of allDefs) {
    const list = defsBySource.get(def.eventSourceId) ?? [];
    list.push(def as EventDefinition);
    defsBySource.set(def.eventSourceId, list);
  }

  return sources.map((s) => ({
    ...s,
    definitions: defsBySource.get(s.id) ?? [],
  }));
}

export async function createEventSource(
  agentId: AgentUuid,
  data: { name: string; sourceType: string; config: Record<string, unknown>; enabled?: boolean },
): Promise<{ id: string; webhookToken: string }> {
  const schema = eventSourceConfigSchemas[data.sourceType];
  if (schema) schema.parse(data.config);

  const webhookToken = generateWebhookToken();
  const encryptedConfig = encrypt(JSON.stringify(data.config));

  const rows = await db
    .insert(eventSources)
    .values({
      agentId,
      name: data.name,
      sourceType: data.sourceType,
      config: encryptedConfig,
      enabled: data.enabled ?? true,
      webhookToken,
    })
    .returning({ id: eventSources.id, webhookToken: eventSources.webhookToken });

  return rows[0];
}

export async function updateEventSource(
  id: string,
  agentId: AgentUuid,
  data: { name?: string; config?: Record<string, unknown>; enabled?: boolean },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) set.name = data.name;
  if (data.enabled !== undefined) set.enabled = data.enabled;
  if (data.config !== undefined) {
    const rows = await db
      .select({
        sourceType: eventSources.sourceType,
        config: eventSources.config,
      })
      .from(eventSources)
      .where(and(eq(eventSources.id, id), eq(eventSources.agentId, agentId)))
      .limit(1);

    const current = rows[0];
    if (current) {
      let existingConfig: Record<string, unknown> = {};
      try {
        existingConfig = JSON.parse(decrypt(current.config)) as Record<string, unknown>;
      } catch {
        webhookLog.warn("WebhookSources", `failed to decrypt config for source ${id}, preserving only incoming keys`);
      }

      const mergedConfig = { ...existingConfig, ...data.config };
      const schema = eventSourceConfigSchemas[current.sourceType];
      if (schema) schema.parse(mergedConfig);
      set.config = encrypt(JSON.stringify(mergedConfig));
    }
  }

  await db.update(eventSources).set(set).where(and(eq(eventSources.id, id), eq(eventSources.agentId, agentId)));
}

export async function deleteEventSource(id: string, agentId: AgentUuid): Promise<void> {
  await db.delete(eventSources).where(and(eq(eventSources.id, id), eq(eventSources.agentId, agentId)));
}

export async function rotateWebhookToken(id: string, agentId: AgentUuid): Promise<string> {
  const newToken = generateWebhookToken();
  await db.update(eventSources).set({ webhookToken: newToken, updatedAt: new Date() }).where(and(eq(eventSources.id, id), eq(eventSources.agentId, agentId)));
  return newToken;
}

export async function findByWebhookToken(token: string): Promise<{ source: EventSource; agentId: AgentUuid } | null> {
  const rows = await db
    .select()
    .from(eventSources)
    .where(eq(eventSources.webhookToken, token))
    .limit(1);

  if (!rows[0]) return null;

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(decrypt(rows[0].config)) as Record<string, unknown>;
  } catch {
    webhookLog.warn("WebhookSources", `failed to decrypt config for token ${token.slice(0, 8)}...`);
  }
  const rowInstanceId = asAgentUuid(rows[0].agentId);
  return { source: { ...rows[0], config, agentId: rowInstanceId }, agentId: rowInstanceId };
}

async function verifyEventSourceOwnership(eventSourceId: string, agentId: AgentUuid): Promise<boolean> {
  const rows = await db
    .select({ id: eventSources.id })
    .from(eventSources)
    .where(and(eq(eventSources.id, eventSourceId), eq(eventSources.agentId, agentId)))
    .limit(1);
  return rows.length > 0;
}

export async function listDefinitions(eventSourceId: string, agentId: AgentUuid): Promise<EventDefinition[]> {
  if (!(await verifyEventSourceOwnership(eventSourceId, agentId))) return [];

  const rows = await db
    .select()
    .from(eventDefinitions)
    .where(eq(eventDefinitions.eventSourceId, eventSourceId));
  return rows as EventDefinition[];
}

export async function listEnabledDefinitions(eventSourceId: string): Promise<EventDefinition[]> {
  const rows = await db
    .select()
    .from(eventDefinitions)
    .where(and(eq(eventDefinitions.eventSourceId, eventSourceId), eq(eventDefinitions.enabled, true)));
  return rows as EventDefinition[];
}

export interface CreateDefinitionData {
  name: string;
  matchingPrompt: string;
  interpretationPrompt: string;
  action?: string;
  contextPrompt?: string;
  outboundChannel?: string;
  outboundTarget?: string;
  enabled?: boolean;
}

export async function createDefinition(
  eventSourceId: string,
  agentId: AgentUuid,
  data: CreateDefinitionData,
): Promise<{ id: string }> {
  if (!(await verifyEventSourceOwnership(eventSourceId, agentId))) {
    throw new Error("Event source not found or does not belong to this instance");
  }

  const rows = await db
    .insert(eventDefinitions)
    .values({
      eventSourceId,
      name: data.name,
      matchingPrompt: data.matchingPrompt,
      interpretationPrompt: data.interpretationPrompt,
      action: data.action ?? "backlog",
      contextPrompt: data.contextPrompt ?? null,
      outboundChannel: data.outboundChannel ?? null,
      outboundTarget: data.outboundTarget ?? null,
      enabled: data.enabled ?? true,
    })
    .returning({ id: eventDefinitions.id });

  return rows[0];
}

export interface UpdateDefinitionData {
  name?: string;
  matchingPrompt?: string;
  interpretationPrompt?: string;
  action?: string;
  contextPrompt?: string | null;
  outboundChannel?: string | null;
  outboundTarget?: string | null;
  enabled?: boolean;
}

export async function updateDefinition(
  id: string,
  eventSourceId: string,
  agentId: AgentUuid,
  data: UpdateDefinitionData,
): Promise<void> {
  if (!(await verifyEventSourceOwnership(eventSourceId, agentId))) return;

  await db.update(eventDefinitions).set({ ...data, updatedAt: new Date() }).where(and(eq(eventDefinitions.id, id), eq(eventDefinitions.eventSourceId, eventSourceId)));
}

export async function deleteDefinition(id: string, eventSourceId: string, agentId: AgentUuid): Promise<void> {
  if (!(await verifyEventSourceOwnership(eventSourceId, agentId))) return;

  await db.delete(eventDefinitions).where(and(eq(eventDefinitions.id, id), eq(eventDefinitions.eventSourceId, eventSourceId)));
}
