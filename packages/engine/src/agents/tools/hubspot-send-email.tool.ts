// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "./hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "./hubspot-portal.js";

export default defineTool({
  name: "hubspotSendEmail",
  description:
    "Send a tracked email via HubSpot and associate it with a CRM contact.\n" +
    "Use for follow-up emails, outreach, commercial communications or notifications. The email is recorded in the contact's timeline.\n" +
    "Do NOT use this tool to create notes — use hubspotNote.\n" +
    "Do NOT use this tool for messaging channels (Telegram, Slack) — use the configured channels.\n" +
    "Returns the sent email ID and its URL in the HubSpot portal.\n" +
    "Caveat: requires contactId (the contact must have an email). The body supports HTML.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Follow-up email",
      input: { contactId: "12345", subject: "Following up on our conversation", body: "Hi Jane, as discussed, here is the summary..." },
    },
  ],
  parameters: z.object({
      contactId: z
        .string()
        .describe("Recipient HubSpot contact ID (the email is automatically associated with the contact)"),
      subject: z
        .string()
        .describe("Email subject"),
      body: z
        .string()
        .describe("Email body (text or HTML)"),
    }),
  execute: async (params: {
      contactId: string;
      subject: string;
      body: string;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      try {
        // Note: hs_email_to_email, hs_email_from_email, hs_email_sender_email
        // are READ-ONLY in the HubSpot API — they cannot be set via API.
        // The association (step 2) links the email to the contact instead.
        const emailProperties: Record<string, string> = {
          hs_email_subject: params.subject,
          hs_email_text: params.body,
          hs_email_html: params.body,
          hs_email_direction: "EMAIL",
          hs_email_status: "SENT",
          hs_timestamp: new Date().toISOString(),
        };

        const createResponse = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/objects/emails",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ properties: emailProperties }),
          },
        );

        if (!createResponse.ok) {
          const respBody = await createResponse.text();
          return { error: `Email creation failed (${createResponse.status}): ${respBody.slice(0, 200)}` };
        }

        const email = (await createResponse.json()) as {
          id: string;
          properties: Record<string, string | null>;
        };

        const assocResponse = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/associations/emails/contacts/batch/create",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              inputs: [
                {
                  from: { id: email.id },
                  to: { id: params.contactId },
                  type: HUBSPOT_ASSOCIATION_TYPES.emailToContact,
                },
              ],
            }),
          },
        );

        if (!assocResponse.ok) {
          const respBody = await assocResponse.text();
          return {
            success: true,
            warning: `Email created (ID: ${email.id}) but association to the contact failed: ${respBody.slice(0, 200)}`,
            email: { id: email.id, subject: params.subject },
          };
        }

        ctx.audit.log({
          action: "crm.sendEmail",
          details: {
            emailId: email.id,
            subject: auditPreview(params.subject),
            contactId: params.contactId,
          },
          success: true,
        });

        const portalId = await getHubSpotPortalId(apiKey);

        return {
          success: true,
          email: {
            id: email.id,
            subject: params.subject,
            contactUrl: hubspotUrl(portalId, "contact", params.contactId),
          },
          message: "Email sent and recorded in the contact timeline.",
        };
      } catch (err) {
        ctx.audit.log({
          action: "crm.sendEmail",
          details: {
            subject: auditPreview(params.subject),
            contactId: params.contactId,
          },
          success: false,
          error: errMsg(err),
        });
        return { error: `Email send failed: ${errMsg(err)}` };
      }
    },
});
