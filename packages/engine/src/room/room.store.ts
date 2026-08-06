// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instanceRoom } from "./room.schema.js";
import { resolveAgentId } from "../instances/resolve-agent-id.js";
import { asAgentUuid, type AgentSlug, type AgentUuid } from "../instances/identifiers.js";

export interface RoomConfig {
  id: string;
  instanceId: AgentUuid;
  enabled: boolean;
  prompt: string;
  outboundChannel: string | null;
  outboundTarget: string | null;
  evalIntervalMinutes: number;
  conversationId: string | null;
}

export async function getRoomBySlug(slug: AgentSlug): Promise<RoomConfig | null> {
  const instanceId = await resolveAgentId(slug);
  if (!instanceId) return null;
  return getRoomByInstanceId(instanceId);
}

export async function getRoomByInstanceId(instanceId: AgentUuid): Promise<RoomConfig | null> {
  const rows = await db
    .select()
    .from(instanceRoom)
    .where(eq(instanceRoom.instanceId, instanceId))
    .limit(1);

  if (!rows[0]) return null;
  return { ...rows[0], instanceId: asAgentUuid(rows[0].instanceId) } as RoomConfig;
}

export async function upsertRoom(
  instanceId: AgentUuid,
  data: {
    enabled?: boolean;
    prompt?: string;
    outboundChannel?: string | null;
    outboundTarget?: string | null;
    evalIntervalMinutes?: number;
  },
): Promise<void> {
  await db
    .insert(instanceRoom)
    .values({
      instanceId,
      enabled: data.enabled ?? false,
      prompt: data.prompt ?? "",
      outboundChannel: data.outboundChannel ?? null,
      outboundTarget: data.outboundTarget ?? null,
      evalIntervalMinutes: data.evalIntervalMinutes ?? 5,
    })
    .onConflictDoUpdate({
      target: [instanceRoom.instanceId],
      set: {
        ...data,
        updatedAt: new Date(),
      },
    });
}

export async function deleteRoom(instanceId: AgentUuid): Promise<void> {
  await db.delete(instanceRoom).where(eq(instanceRoom.instanceId, instanceId));
}

export async function setRoomConversationId(instanceId: AgentUuid, conversationId: string): Promise<void> {
  await db
    .update(instanceRoom)
    .set({ conversationId, updatedAt: new Date() })
    .where(eq(instanceRoom.instanceId, instanceId));
}

export async function listEnabledRooms(): Promise<RoomConfig[]> {
  const rows = await db
    .select()
    .from(instanceRoom)
    .where(eq(instanceRoom.enabled, true));
  return rows.map((r) => ({ ...r, instanceId: asAgentUuid(r.instanceId) })) as RoomConfig[];
}
