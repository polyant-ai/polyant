// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { registerTool } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { channelManager } from "../../channels/channel-manager.js";

registerTool({
  name: "whatsappSendMessage",
  description:
    "Send a WhatsApp message (text and/or a media attachment) using the Twilio WhatsApp channel configured on the current instance.\n" +
    "The 'to' parameter is the recipient's number in E.164 format (e.g. '+14155550100'). " +
    "To reply to the same user as this conversation, use the sender's number.\n" +
    "Optional 'mediaUrl' parameter: a public HTTPS URL (e.g. the publicUrl returned by hubspotFile) that Twilio downloads and delivers as an attachment (PDF, image, etc.).\n" +
    "Caveat: requires the instance to have the 'whatsapp' channel active. The body may be empty when only mediaUrl is passed.",
  category: "messaging",
  inputExamples: [
    {
      label: "Send text to a contact",
      input: { to: "+14155550100", message: "Hi, how are you?", mediaUrl: null },
    },
    {
      label: "Send a PDF as an attachment with a covering message",
      input: {
        to: "+14155550100",
        message: "Here is the quote you requested.",
        mediaUrl: "https://hubspot.example/files/abc.pdf",
      },
    },
  ],
  create: (ctx) => ({
    parameters: z.object({
      to: z
        .string()
        .min(1)
        .describe("WhatsApp recipient number in E.164 format (e.g. '+14155550100')."),
      message: z
        .string()
        .describe("Message text. May be empty when mediaUrl is present."),
      mediaUrl: z
        .string()
        .nullable()
        .describe("Public HTTPS URL to attach as media (e.g. a hubspotFile publicUrl). Must start with https://."),
    }),
    execute: async ({ to, message, mediaUrl }: { to: string; message: string; mediaUrl: string | null }) => {
      const trimmedTo = to.trim();
      const trimmedMessage = message.trim();

      if (!trimmedTo) {
        return { error: "Parameter 'to' is empty." };
      }
      if (!trimmedMessage && !mediaUrl) {
        return { error: "Specify at least one of 'message' and 'mediaUrl'." };
      }
      if (mediaUrl && !/^https:\/\//.test(mediaUrl)) {
        return { error: "mediaUrl must be an absolute https:// URL." };
      }

      try {
        await channelManager.sendOutbound(
          ctx.instanceId,
          "whatsapp",
          trimmedTo,
          trimmedMessage,
          mediaUrl ? { mediaUrl } : undefined,
        );

        ctx.audit.log({
          action: "whatsapp.sendMessage",
          details: {
            to: auditPreview(trimmedTo),
            messageLen: trimmedMessage.length,
            hasMedia: Boolean(mediaUrl),
          },
          success: true,
        });

        return {
          success: true,
          to: trimmedTo,
          messageLen: trimmedMessage.length,
          ...(mediaUrl ? { mediaUrl } : {}),
        };
      } catch (err) {
        ctx.audit.log({
          action: "whatsapp.sendMessage",
          details: { to: auditPreview(trimmedTo), messageLen: trimmedMessage.length, hasMedia: Boolean(mediaUrl) },
          success: false,
          error: errMsg(err),
        });
        return { error: `WhatsApp send failed: ${errMsg(err)}` };
      }
    },
  }),
});
