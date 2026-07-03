// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { channelManager } from "../../channels/channel-manager.js";

export default defineTool({
  name: "slackPostMessage",
  description:
    "Post a message to Slack using the Slack channel configured on the current instance.\n" +
    "The `channel` parameter accepts: channel name with '#' (e.g. '#introductions'), channel ID (e.g. 'C01ABCDEF'), or user ID (e.g. 'U01XYZ123') for a DM.\n" +
    "Returns a send confirmation, or an error if the Slack channel is not configured for this instance or the Slack API rejects the call.\n" +
    "Caveat: requires the `slack` channel to be enabled on the instance (`instance_channels`). Text supports Slack mrkdwn syntax (e.g. *bold*, _italic_, <url|label>).",
  category: "messaging",
  requiredSecrets: [
    {
      key: "slack_allowed_channels",
      type: "text",
      label: "Slack allowed channels (allowlist)",
      description:
        "Optional comma-separated list of allowed destinations (e.g. '#introductions,C01ABCDEF,U01XYZ123'). If set, the tool will refuse to post to any channel/user not in the list (case-insensitive exact match). Leave empty to allow any destination.",
      optional: true,
    },
  ],
  inputExamples: [
    {
      label: "Forward an introduction request to a coordination channel",
      input: {
        channel: "#introductions",
        message: "🤝 *Anna Bianchi* (Acme) would like to meet *Marco Rossi* (Globex). Please coordinate the introduction.",
      },
    },
    {
      label: "Send a DM to a Slack user",
      input: { channel: "U01ABCDEF", message: "Private note: new attendee has arrived at the desk." },
    },
    {
      label: "Use an explicit channel ID",
      input: { channel: "C09876XYZ", message: "Alert: event backlog > 50." },
    },
  ],
  parameters: z.object({
    channel: z
      .string()
      .min(1)
      .describe(
        "Slack destination. Accepts: channel name with '#' (e.g. '#introductions'), channel ID ('C...'), or user ID ('U...') for a DM.",
      ),
    message: z
      .string()
      .min(1)
      .describe("Message text. Slack mrkdwn syntax supported."),
  }),
  execute: async ({ channel, message }: { channel: string; message: string }, ctx) => {
    const trimmedChannel = channel.trim();
    const trimmedMessage = message.trim();

    if (!trimmedChannel) {
      return { error: "Parameter 'channel' is empty." };
    }
    if (!trimmedMessage) {
      return { error: "Parameter 'message' is empty." };
    }

    // Per-instance allowlist (opt-in). If the secret is set (non-empty after trim),
    // the requested channel MUST appear in the comma-separated list.
    // Matching is case-insensitive exact match on trimmed entries.
    const rawAllowlist = ctx.secrets?.["slack_allowed_channels"]?.trim();
    if (rawAllowlist) {
      const allowed = rawAllowlist
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => s.toLowerCase());
      if (!allowed.includes(trimmedChannel.toLowerCase())) {
        ctx.audit.log({
          action: "slack.postMessage",
          details: {
            channel: auditPreview(trimmedChannel),
            messageLen: trimmedMessage.length,
            decision: "blocked_by_allowlist",
          },
          success: false,
          error: "Channel not in instance allowlist",
        });
        return { success: false, error: "Channel not in instance allowlist" };
      }
    }

    try {
      await channelManager.sendOutbound(ctx.instanceId, "slack", trimmedChannel, trimmedMessage);

      ctx.audit.log({
        action: "slack.postMessage",
        details: {
          channel: auditPreview(trimmedChannel),
          messageLen: trimmedMessage.length,
        },
        success: true,
      });

      return {
        success: true,
        channel: trimmedChannel,
        messageLen: trimmedMessage.length,
      };
    } catch (err) {
      ctx.audit.log({
        action: "slack.postMessage",
        details: { channel: auditPreview(trimmedChannel), messageLen: trimmedMessage.length },
        success: false,
        error: errMsg(err),
      });
      return { error: `Slack send failed: ${errMsg(err)}` };
    }
  },
});
