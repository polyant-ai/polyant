// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { channelManager } from "../../channels/channel-manager.js";
import { getTriggerContext } from "../../webhooks/trigger-context.js";
import { renderStubTemplate } from "../../channels/adapters/whatsapp/stub-templates.js";

// Primary path: send via Twilio Content API (contentSid + contentVariables).
// After delivery succeeds, the real rendered body of the template is fetched
// from the Twilio Content API (cached per process) and persisted as the
// assistant message. Fallbacks: stub catalog (legacy slug-keyed) → compact
// summary with the variables. The stub catalog is kept as a fallback for
// rare Content API outages and as a placeholder delivery path; switch the
// body below back to `channelManager.sendOutbound(..., renderStubTemplate(...))`
// if Twilio templates are unavailable.

export default defineTool({
  name: "send_whatsapp_template",
  description:
    "Send an approved Twilio WhatsApp template to the user, instead of a free-form text reply.\n" +
    "Use this when you need to deliver a structured, business-initiated message (e.g. outside the 24h window) " +
    "whose Twilio contentSid and positional variables are provided in your conversation context.\n" +
    "On success the engine will NOT also send your free-form text response — the template IS the reply.\n" +
    "Only available inside a webhook-triggered conversation on a WhatsApp outbound channel.",
  category: "whatsapp",
  harness: true,
  parameters: z.object({
    contentSid: z
      .string()
      .regex(/^HX[A-Za-z0-9]+$/, "contentSid must be a Twilio Content SID (HX followed by alphanumeric characters)")
      .describe(
        "Twilio Content SID of the approved template (format HX... followed by alphanumeric). Provided in your conversation context.",
      ),
    variables: z
      .array(z.string())
      .describe(
        "Positional replacements for the template placeholders. " +
        "The array is POSITIONAL: index 0 replaces {{1}}, index 1 replaces {{2}}, and so on. " +
        'Example: for a template with {{1}} and {{2}}, pass ["Jane", "14:30"]. ' +
        "Include an entry for EVERY placeholder in the template; pass [] for templates without placeholders.",
      ),
  }),
  execute: async ({ contentSid, variables }: { contentSid: string; variables: string[] }, ctx) => {
    // Convert positional array to 1-based index map for Twilio contentVariables
    const variablesMap: Record<string, string> = Object.fromEntries(
      variables.map((value, index) => [String(index + 1), value]),
    );

    const triggerCtx = getTriggerContext(ctx.conversationId ?? "");
    if (!triggerCtx) {
      return {
        error:
          "No active trigger context. This tool is only available in webhook-triggered conversations.",
      };
    }

    if (triggerCtx.outboundChannel !== "whatsapp") {
      return {
        error: `Active outbound channel is "${triggerCtx.outboundChannel}", not whatsapp. Template send not supported.`,
      };
    }

    try {
      const messageSid = await channelManager.sendOutboundTemplate(
        triggerCtx.instanceSlug,
        triggerCtx.outboundChannel,
        triggerCtx.outboundTarget,
        contentSid,
        variablesMap,
      );

      // Resolve the actual body the user sees on WhatsApp so the agent
      // remembers what it said and operators reading the conversation in
      // the admin panel see the real message — not a SID + variables blob.
      // Cascade of fallbacks if Twilio's Content API is unreachable.
      let replyText: string;
      try {
        replyText = await channelManager.getOutboundTemplateBody(
          triggerCtx.instanceSlug,
          triggerCtx.outboundChannel,
          contentSid,
          variablesMap,
        );
      } catch (err) {
        console.warn(
          `[send_whatsapp_template] content api fetch failed for ${contentSid}: ${err instanceof Error ? err.message : String(err)} — falling back to stub catalog / summary`,
        );
        replyText =
          renderStubTemplate(contentSid, variablesMap) ??
          `[WhatsApp template sent: ${contentSid} · variables: ${JSON.stringify(variables)}]`;
      }

      return {
        success: true,
        replyHandled: true,
        replyText,
        contentSid,
        target: triggerCtx.outboundTarget,
        messageSid,
      };
    } catch (err) {
      return {
        error: `Failed to send WhatsApp template: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
