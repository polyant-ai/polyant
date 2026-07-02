// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES, resolveOwnerIdFromEmail } from "./hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "./hubspot-portal.js";
import { ensureHtmlBody } from "./hubspot-rich-text.js";

export default defineTool({
  name: "hubspotCreateTask",
  description:
    "Create a task in the HubSpot CRM and associate it with a contact.\n" +
    "Use to record activities to complete: callback requests, follow-ups, operational tasks.\n" +
    "Do NOT use to create notes — use hubspotNote.\n" +
    "Do NOT use to create appointments — use hubspotMeeting.\n" +
    "Returns the created task ID and its URL in the HubSpot portal.\n" +
    "Caveat: dueDate is optional but recommended. priority accepts the standard HubSpot values (HIGH, MEDIUM, LOW).\n" +
    "Owner: to assign the task to a specific HubSpot user, pass ownerEmail (e.g. 'jane.doe@acme.com') or, if you already know the numeric id, ownerId. If both are null the task is created without an owner.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Callback task",
      input: { contactId: "12345", subject: "Callback requested", body: "The contact asked to be called back at 3pm", priority: "HIGH", dueDate: "2026-04-10" },
    },
    {
      label: "Task assigned to a specific owner via email",
      input: { contactId: "12345", subject: "Lead review", body: "Out-of-policy items to review", priority: "HIGH", dueDate: "2026-04-12", ownerEmail: "jane.doe@acme.com" },
    },
  ],
  parameters: z.object({
      contactId: z
        .string()
        .describe("HubSpot contact ID to associate the task with"),
      subject: z
        .string()
        .describe(
          "Task subject (e.g. 'Callback — Jane Doe')",
        ),
      body: z
        .string()
        .nullable()
        .describe(
          "Detailed description: reason for the task and conversation summary",
        ),
      priority: z
        .enum(["LOW", "MEDIUM", "HIGH"])
        .describe("Task priority"),
      dueDate: z
        .string()
        .nullable()
        .describe("Due date in ISO 8601. If null, set to today."),
      ownerEmail: z
        .string()
        .nullable()
        .describe(
          "Email of the HubSpot user to assign the task to (e.g. 'jane.doe@acme.com'). " +
          "The tool resolves the email to `hubspot_owner_id` internally. " +
          "If the email cannot be resolved, the task is created without an owner and a warning is added. " +
          "If `ownerId` is also provided, `ownerId` wins.",
        ),
      ownerId: z
        .string()
        .nullable()
        .describe(
          "Numeric HubSpot owner ID (alternative to ownerEmail, when you already know it). " +
          "Wins over ownerEmail when both are passed.",
        ),
    }),
  execute: async ({
      contactId,
      subject,
      body,
      priority,
      dueDate,
      ownerEmail,
      ownerId,
    }: {
      contactId: string;
      subject: string;
      body: string | null;
      priority: "LOW" | "MEDIUM" | "HIGH";
      dueDate: string | null;
      ownerEmail: string | null;
      ownerId: string | null;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      try {
        const timestamp = dueDate ? new Date(dueDate) : new Date();
        if (isNaN(timestamp.getTime())) {
          return {
            error:
              "Invalid date format. Use ISO 8601 (e.g. 2026-03-20T10:00:00).",
          };
        }

        // Resolve owner: ownerId prevails, else lookup by ownerEmail.
        // If resolution fails, we still create the task but flag a warning
        // in the response (owner-less task is recoverable; failing the
        // whole call would mask the more important task body).
        let resolvedOwnerId: string | null = ownerId;
        let ownerWarning: string | null = null;
        if (!resolvedOwnerId && ownerEmail) {
          resolvedOwnerId = await resolveOwnerIdFromEmail(apiKey, ownerEmail);
          if (!resolvedOwnerId) {
            ownerWarning = `HubSpot owner not found for email "${ownerEmail}" — task created without owner.`;
          }
        }

        // 1. Create the task
        const taskProperties: Record<string, string> = {
          hs_task_subject: subject,
          hs_task_priority: priority,
          hs_timestamp: timestamp.toISOString(),
          hs_task_status: "NOT_STARTED",
          hs_task_type: "CALL",
        };
        if (resolvedOwnerId) {
          taskProperties.hubspot_owner_id = resolvedOwnerId;
        }

        // HubSpot renders task body as HTML. Auto-convert plain-text
        // newlines to <br> so LLM-emitted bodies stay readable.
        if (body) taskProperties.hs_task_body = ensureHtmlBody(body);

        const createResponse = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/objects/tasks",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ properties: taskProperties }),
          },
        );

        if (!createResponse.ok) {
          const respBody = await createResponse.text();
          return {
            error: `Task creation failed (${createResponse.status}): ${respBody.slice(0, 200)}`,
          };
        }

        const task = (await createResponse.json()) as {
          id: string;
          properties: Record<string, string | null>;
        };

        // 2. Associate task with contact (type 204 = task-to-contact)
        const assocResponse = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/associations/tasks/contacts/batch/create",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              inputs: [
                {
                  from: { id: task.id },
                  to: { id: contactId },
                  type: HUBSPOT_ASSOCIATION_TYPES.taskToContact,
                },
              ],
            }),
          },
        );

        if (!assocResponse.ok) {
          const respBody = await assocResponse.text();
          return {
            success: true,
            warning: `Task created (ID: ${task.id}) but association to the contact failed: ${respBody.slice(0, 200)}`,
            task: { id: task.id, subject, priority, ...(resolvedOwnerId ? { ownerId: resolvedOwnerId } : {}) },
            ...(ownerWarning ? { ownerWarning } : {}),
          };
        }

        ctx.audit.log({
          action: "crm.createTask",
          details: {
            subject: auditPreview(subject),
            dueDate: dueDate ?? "today",
            contactId,
            ...(resolvedOwnerId ? { ownerId: resolvedOwnerId } : {}),
            ...(ownerEmail ? { ownerEmail: auditPreview(ownerEmail) } : {}),
          },
          success: true,
        });

        const portalId = await getHubSpotPortalId(apiKey);

        return {
          success: true,
          task: {
            id: task.id,
            subject,
            priority,
            dueDate: timestamp.toISOString(),
            contactUrl: hubspotUrl(portalId, "contact", contactId),
            ...(resolvedOwnerId ? { ownerId: resolvedOwnerId } : {}),
          },
          message:
            "Task created successfully and associated with the contact.",
          ...(ownerWarning ? { ownerWarning } : {}),
        };
      } catch (err) {
        ctx.audit.log({
          action: "crm.createTask",
          details: { contactId },
          success: false,
          error: errMsg(err),
        });
        return {
          error: `Task creation failed: ${errMsg(err)}`,
        };
      }
    },
});
