// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { registerTool } from "./registry.js";
import { channelManager } from "../../channels/channel-manager.js";
import { getTriggerContext } from "../../webhooks/trigger-context.js";

registerTool({
  name: "send_outbound_message",
  description:
    "Send a message to the user via the configured outbound channel.\n" +
    "Use this tool to send the initial message or follow-up messages in a webhook-triggered conversation.\n" +
    "The outbound channel and target are determined by the trigger configuration.\n" +
    "Optionally attach a public HTTPS media URL (e.g. a PDF link from hubspotFile) — supported on WhatsApp via Twilio; ignored by channels that don't support outbound media.\n" +
    "Returns confirmation that the message was sent.\n" +
    "Caveat: only available in webhook-triggered conversation context.",
  category: "conversation-trigger",
  harness: true,
  create: (ctx) => ({
    parameters: z.object({
      message: z.string().describe("The message to send to the user"),
      mediaUrl: z
        .string()
        .nullable()
        .describe("Optional public HTTPS URL to attach as media (e.g. PDF). Must start with https://. Currently honored only by WhatsApp."),
    }),
    execute: async ({ message, mediaUrl }: { message: string; mediaUrl: string | null }) => {
      const triggerCtx = getTriggerContext(ctx.conversationId ?? "");
      if (!triggerCtx) {
        return { error: "No active trigger context. This tool is only available in webhook-triggered conversations." };
      }

      if (mediaUrl && !/^https:\/\//.test(mediaUrl)) {
        return { error: "mediaUrl must be an absolute https:// URL." };
      }

      try {
        await channelManager.sendOutbound(
          triggerCtx.instanceSlug,
          triggerCtx.outboundChannel,
          triggerCtx.outboundTarget,
          message,
          mediaUrl ? { mediaUrl } : undefined,
        );
      } catch (err) {
        return { error: `Failed to send outbound message: ${err instanceof Error ? err.message : String(err)}` };
      }

      return {
        success: true,
        replyHandled: true,
        replyText: message,
        ...(mediaUrl ? { mediaUrl } : {}),
        channel: triggerCtx.outboundChannel,
        target: triggerCtx.outboundTarget,
      };
    },
  }),
});
