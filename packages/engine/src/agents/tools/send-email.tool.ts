// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import sgMail from "@sendgrid/mail";
import { registerTool } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { config } from "../../config.js";

registerTool({
  name: "sendEmail",
  description:
    "Send an email via SendGrid.\n" +
    "The `to` parameter must be a valid recipient email address.\n" +
    "The `subject` parameter sets the email subject line; if omitted, the SENDGRID_DEFAULT_SUBJECT env var is used, or the first 60 characters of the message body.\n" +
    "Returns a send confirmation, or an error if SendGrid is not configured (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL) or the API call fails.\n" +
    "Sender address and credentials are configured via environment variables — no per-instance setup required.",
  category: "messaging",
  // CONVENTION-EXCEPTION: requiredEnv reads process.env intentionally for tool
  // availability discovery at boot — see CLAUDE.md and registry.ts comments.
  requiredEnv: ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL"],
  requiredSecrets: [
    {
      key: "sendgrid_allowed_recipients",
      type: "text",
      label: "SendGrid allowed recipients (allowlist)",
      description:
        "Optional comma-separated list of allowed recipient email addresses. If set, the tool will refuse to send to any address not in the list (case-insensitive). Leave empty to allow any recipient.",
      optional: true,
    },
  ],
  inputExamples: [
    {
      label: "Send an event confirmation email",
      input: {
        to: "user@example.com",
        subject: "Your booking is confirmed",
        message: "Hi,\n\nYour booking for the event has been confirmed. See you there!\n\nBest regards,\nThe Team",
      },
    },
    {
      label: "Send a notification without explicit subject",
      input: {
        to: "admin@example.com",
        message: "Alert: the daily report is ready and available in the dashboard.",
      },
    },
  ],
  create: (ctx) => ({
    parameters: z.object({
      to: z.string().email().describe("Recipient email address."),
      subject: z
        .string()
        .optional()
        .describe(
          "Email subject line. If omitted, SENDGRID_DEFAULT_SUBJECT is used, or the first 60 characters of the message body.",
        ),
      message: z.string().min(1).describe("Email body text."),
    }),
    execute: async ({ to, subject, message }: { to: string; subject?: string; message: string }) => {
      const sg = config.sendgrid;
      if (!sg) {
        return { error: "SendGrid is not configured (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL missing)." };
      }

      const trimmedTo = to.trim();
      const trimmedMessage = message.trim();

      if (!trimmedTo) return { error: "Parameter 'to' is empty." };
      if (!trimmedMessage) return { error: "Parameter 'message' is empty." };

      // Per-instance recipient allowlist (opt-in). Case-insensitive exact match.
      const rawAllowlist = ctx.secrets?.["sendgrid_allowed_recipients"]?.trim();
      if (rawAllowlist) {
        const allowed = rawAllowlist
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0);
        if (!allowed.includes(trimmedTo.toLowerCase())) {
          ctx.audit.log({
            action: "sendgrid.sendEmail",
            details: { to: auditPreview(trimmedTo), messageLen: trimmedMessage.length, decision: "blocked_by_allowlist" },
            success: false,
            error: "Recipient not in instance allowlist",
          });
          return { success: false, error: "Recipient not in instance allowlist" };
        }
      }

      const resolvedSubject =
        subject?.trim() ||
        sg.defaultSubject ||
        trimmedMessage.slice(0, 60).replace(/\n/g, " ").trimEnd();

      const from = sg.fromName ? { name: sg.fromName, email: sg.fromEmail } : sg.fromEmail;
      const htmlBody = `<pre style="font-family:inherit;white-space:pre-wrap;word-break:break-word;">${escapeHtml(trimmedMessage)}</pre>`;

      try {
        sgMail.setApiKey(sg.apiKey);
        await sgMail.send({ to: trimmedTo, from, subject: resolvedSubject, text: trimmedMessage, html: htmlBody });

        ctx.audit.log({
          action: "sendgrid.sendEmail",
          details: { to: auditPreview(trimmedTo), messageLen: trimmedMessage.length },
          success: true,
        });

        return { success: true, to: trimmedTo, messageLen: trimmedMessage.length };
      } catch (err) {
        ctx.audit.log({
          action: "sendgrid.sendEmail",
          details: { to: auditPreview(trimmedTo), messageLen: trimmedMessage.length },
          success: false,
          error: errMsg(err),
        });
        return { error: `SendGrid send failed: ${errMsg(err)}` };
      }
    },
  }),
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
