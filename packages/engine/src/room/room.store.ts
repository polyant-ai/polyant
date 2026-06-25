// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { agentRoom } from "./room.schema.js";
import { resolveAgentId } from "../instances/resolve-agent-id.js";
import { asAgentUuid, type AgentSlug, type AgentUuid } from "../instances/identifiers.js";

export interface RoomConfig {
  id: string;
  agentId: AgentUuid;
  enabled: boolean;
  prompt: string;
  outboundChannel: string | null;
  outboundTarget: string | null;
  evalIntervalMinutes: number;
  conversationId: string | null;
}

export async function getRoomBySlug(slug: AgentSlug): Promise<RoomConfig | null> {
  const agentId = await resolveAgentId(slug);
  if (!agentId) return null;
  return getRoomByInstanceId(agentId);
}

export async function getRoomByInstanceId(agentId: AgentUuid): Promise<RoomConfig | null> {
  const rows = await db
    .select()
    .from(agentRoom)
    .where(eq(agentRoom.agentId, agentId))
    .limit(1);

  if (!rows[0]) return null;
  return { ...rows[0], agentId: asAgentUuid(rows[0].agentId) } as RoomConfig;
}

export async function upsertRoom(
  agentId: AgentUuid,
  data: {
    enabled?: boolean;
    prompt?: string;
    outboundChannel?: string | null;
    outboundTarget?: string | null;
    evalIntervalMinutes?: number;
  },
): Promise<void> {
  await db
    .insert(agentRoom)
    .values({
      agentId,
      enabled: data.enabled ?? false,
      prompt: data.prompt ?? "",
      outboundChannel: data.outboundChannel ?? null,
      outboundTarget: data.outboundTarget ?? null,
      evalIntervalMinutes: data.evalIntervalMinutes ?? 5,
    })
    .onConflictDoUpdate({
      target: [agentRoom.agentId],
      set: {
        ...data,
        updatedAt: new Date(),
      },
    });
}

export async function deleteRoom(agentId: AgentUuid): Promise<void> {
  await db.delete(agentRoom).where(eq(agentRoom.agentId, agentId));
}

export async function setRoomConversationId(agentId: AgentUuid, conversationId: string): Promise<void> {
  await db
    .update(agentRoom)
    .set({ conversationId, updatedAt: new Date() })
    .where(eq(agentRoom.agentId, agentId));
}

export async function listEnabledRooms(): Promise<RoomConfig[]> {
  const rows = await db
    .select()
    .from(agentRoom)
    .where(eq(agentRoom.enabled, true));
  return rows.map((r) => ({ ...r, agentId: asAgentUuid(r.agentId) })) as RoomConfig[];
}
