// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { registerTool } from "./registry.js";
import { channelManager } from "../../channels/channel-manager.js";
import { getRoomByInstanceId } from "../../room/room.store.js";
import { resolveAgentId } from "../../instances/resolve-agent-id.js";

registerTool({
  name: "send_message_to_human",
  description:
    "Send a proactive message to the human via the configured outbound channel.\n" +
    "Use to notify the user about events, send reminders, or communicate proactive insights.\n" +
    "Do NOT use inside regular conversations — this is for the Room (event-driven) context only.\n" +
    "Returns confirmation that the message was sent.\n" +
    "Caveat: requires a configured outbound channel (Telegram, Slack, or WhatsApp) on the instance's Room. Message is plain text.",
  category: "room",
  harness: true,
  create: (ctx) => ({
    parameters: z.object({
      message: z.string().describe("The message to send to the human"),
    }),
    execute: async ({ message }) => {
      const agentId = await resolveAgentId(ctx.agentId);
      if (!agentId) return { error: "Agent not found" };

      const room = await getRoomByInstanceId(agentId);
      if (!room) return { error: "Room not configured for this instance" };
      if (!room.outboundChannel || !room.outboundTarget) {
        return { error: "Outbound channel not configured in room settings" };
      }

      await channelManager.sendOutbound(ctx.agentId, room.outboundChannel, room.outboundTarget, message);

      return { success: true, channel: room.outboundChannel, target: room.outboundTarget };
    },
  }),
});
