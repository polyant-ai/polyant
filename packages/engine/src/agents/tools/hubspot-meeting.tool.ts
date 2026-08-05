// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "./hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "./hubspot-portal.js";

export default defineTool({
  name: "hubspotMeeting",
  description:
    "Manage meetings (appointments) in the HubSpot CRM: create, retrieve or update meetings.\n" +
    "Use action 'create' for new meetings, 'get' to list a contact's meetings, 'update' to modify them.\n" +
    "Returns the meeting ID and its URL in the HubSpot portal.\n" +
    "Caveat: for 'create', startTime and endTime must be ISO 8601 and contactId is required. For 'get', returns future meetings plus those from the last 30 days. For 'update', only properties explicitly passed are updated.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Create a meeting",
      input: { action: "create", contactId: "12345", title: "Intro call", startTime: "2026-04-15T10:00:00.000Z", endTime: "2026-04-15T10:30:00.000Z" },
    },
    {
      label: "Get a contact's meetings",
      input: { action: "get", contactId: "12345" },
    },
    {
      label: "Update the outcome of a meeting",
      input: {
        action: "update",
        meetingId: "67890",
        properties: {
          hs_meeting_outcome: "COMPLETED",
          hs_meeting_start_time: null,
          hs_meeting_end_time: null,
          hs_meeting_title: null,
        },
      },
    },
  ],
  parameters: z.object({
      action: z.enum(["create", "get", "update"]).describe("'create' for a new meeting, 'get' to retrieve, 'update' to modify"),
      // --- create params ---
      contactId: z
        .string()
        .nullable()
        .describe("HubSpot contact ID (required for create and get)"),
      title: z
        .string()
        .nullable()
        .describe("Meeting title (required for create)"),
      startTime: z
        .union([z.string(), z.number()])
        .nullable()
        .describe("Start date/time: ISO 8601 string or epoch milliseconds (required for create)"),
      endTime: z
        .union([z.string(), z.number()])
        .nullable()
        .describe("End date/time: ISO 8601 string or epoch milliseconds (required for create)"),
      description: z
        .string()
        .nullable()
        .describe("Meeting description or notes (create only)"),
      location: z
        .string()
        .nullable()
        .describe("Meeting location (create only)"),
      // --- update params ---
      meetingId: z
        .string()
        .nullable()
        .describe("HubSpot meeting ID to update (required for update)"),
      properties: z.object({
        hs_meeting_outcome: z
          .string()
          .nullable()
          .describe("Meeting outcome (e.g. 'COMPLETED', 'CANCELED', 'RESCHEDULED', 'NO_SHOW')"),
        hs_meeting_start_time: z
          .string()
          .nullable()
          .describe("Start date/time in ISO 8601 format"),
        hs_meeting_end_time: z
          .string()
          .nullable()
          .describe("End date/time in ISO 8601 format"),
        hs_meeting_title: z
          .string()
          .nullable()
          .describe("Meeting title"),
      }).nullable().describe("Meeting properties to update (update only)"),
    }),
  execute: async (params: {
      action: "create" | "get" | "update";
      contactId: string | null;
      title: string | null;
      startTime: string | number | null;
      endTime: string | number | null;
      description: string | null;
      location: string | null;
      meetingId: string | null;
      properties: {
        hs_meeting_outcome: string | null;
        hs_meeting_start_time: string | null;
        hs_meeting_end_time: string | null;
        hs_meeting_title: string | null;
      } | null;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      if (params.action === "get") {
        if (!params.contactId) {
          return { error: "contactId is required for action 'get'." };
        }
        return getMeetings(ctx, apiKey, params.contactId);
      }

      if (params.action === "update") {
        if (!params.meetingId) {
          return { error: "meetingId is required for action 'update'." };
        }
        return updateMeeting(ctx, apiKey, params.meetingId, params.properties);
      }

      return createMeeting(ctx, apiKey, params);
    },
});

async function createMeeting(
  ctx: ToolContext,
  apiKey: string,
  params: {
    contactId: string | null;
    title: string | null;
    startTime: string | number | null;
    endTime: string | number | null;
    description: string | null;
    location: string | null;
  },
) {
  if (!params.contactId || !params.title || params.startTime == null || params.endTime == null) {
    return { error: "contactId, title, startTime and endTime are required for action 'create'." };
  }

  const { contactId, title, startTime, endTime, description, location } = params;

  try {
    const start = typeof startTime === "number" ? new Date(startTime) : new Date(startTime);
    const end = typeof endTime === "number" ? new Date(endTime) : new Date(endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { error: "Invalid date/time format. Use ISO 8601 (e.g. 2026-03-20T10:00:00) or epoch milliseconds." };
    }
    if (end <= start) {
      return { error: "End time must be after start time." };
    }

    const meetingProperties: Record<string, string> = {
      hs_timestamp: start.toISOString(),
      hs_meeting_title: title,
      hs_meeting_start_time: start.toISOString(),
      hs_meeting_end_time: end.toISOString(),
      hs_meeting_outcome: "SCHEDULED",
    };

    if (description) meetingProperties.hs_meeting_body = description;
    if (location) meetingProperties.hs_meeting_location = location;

    const createResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/meetings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ properties: meetingProperties }),
      },
    );

    if (!createResponse.ok) {
      const body = await createResponse.text();
      return { error: `Meeting creation failed (${createResponse.status}): ${body.slice(0, 200)}` };
    }

    const meeting = (await createResponse.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const assocResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/associations/meetings/contacts/batch/create",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          inputs: [
            {
              from: { id: meeting.id },
              to: { id: contactId },
              type: HUBSPOT_ASSOCIATION_TYPES.meetingToContact,
            },
          ],
        }),
      },
    );

    if (!assocResponse.ok) {
      const body = await assocResponse.text();

      ctx.audit.log({
        action: "crm.createMeeting",
        details: {
          meetingId: meeting.id,
          title: auditPreview(title),
          startTime: start.toISOString(),
          contactId,
          warning: "association failed",
        },
        success: true,
      });

      return {
        success: true,
        warning: `Meeting created (ID: ${meeting.id}) but association to the contact failed: ${body.slice(0, 200)}`,
        meeting: {
          id: meeting.id,
          title,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          location: location ?? null,
        },
      };
    }

    ctx.audit.log({
      action: "crm.createMeeting",
      details: {
        meetingId: meeting.id,
        title: auditPreview(title),
        startTime: start.toISOString(),
        contactId,
      },
      success: true,
    });

    const portalId = await getHubSpotPortalId(apiKey);

    return {
      success: true,
      meeting: {
        id: meeting.id,
        title,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        location: location ?? null,
        contactUrl: hubspotUrl(portalId, "contact", contactId),
      },
      message: `Meeting created successfully for ${start.toISOString()}.`,
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.createMeeting",
      details: { contactId },
      success: false,
      error: errMsg(err),
    });
    return { error: `Meeting creation failed: ${errMsg(err)}` };
  }
}

async function getMeetings(
  ctx: ToolContext,
  apiKey: string,
  contactId: string,
) {
  try {
    const assocResponse = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/meetings`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (!assocResponse.ok) {
      const body = await assocResponse.text();
      return { error: `Failed to fetch meeting associations (${assocResponse.status}): ${body.slice(0, 200)}` };
    }

    const assocData = (await assocResponse.json()) as {
      results: Array<{ id: string; type: string }>;
    };

    if (!assocData.results || assocData.results.length === 0) {
      return { found: 0, meetings: [], message: "No meetings found for this contact." };
    }

    const meetingIds = assocData.results.map((r) => ({ id: r.id }));

    const batchResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/meetings/batch/read",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          inputs: meetingIds,
          properties: [
            "hs_meeting_title",
            "hs_meeting_start_time",
            "hs_meeting_end_time",
            "hs_meeting_outcome",
            "hs_meeting_location",
          ],
        }),
      },
    );

    if (!batchResponse.ok) {
      const body = await batchResponse.text();
      return { error: `Failed to fetch meeting details (${batchResponse.status}): ${body.slice(0, 200)}` };
    }

    const batchData = (await batchResponse.json()) as {
      results: Array<{
        id: string;
        properties: Record<string, string | null>;
      }>;
    };

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const portalId = await getHubSpotPortalId(apiKey);

    const filtered = batchData.results
      .filter((m) => {
        const startTime = m.properties.hs_meeting_start_time;
        if (!startTime) return false;
        const start = new Date(startTime);
        return start > thirtyDaysAgo;
      })
      .map((m) => {
        const startDate = new Date(m.properties.hs_meeting_start_time!);
        const endDate = m.properties.hs_meeting_end_time
          ? new Date(m.properties.hs_meeting_end_time)
          : null;

        return {
          id: m.id,
          title: m.properties.hs_meeting_title ?? "Untitled",
          startTime: startDate.toISOString(),
          endTime: endDate ? endDate.toISOString() : null,
          location: m.properties.hs_meeting_location ?? null,
          outcome: m.properties.hs_meeting_outcome ?? null,
          isFuture: startDate > now,
        };
      })
      .sort((a, b) => {
        if (a.isFuture && !b.isFuture) return -1;
        if (!a.isFuture && b.isFuture) return 1;
        return 0;
      });

    ctx.audit.log({
      action: "crm.getMeetings",
      details: {
        contactId,
        resultCount: filtered.length,
      },
      success: true,
    });

    return {
      found: filtered.length,
      meetings: filtered,
      contactUrl: hubspotUrl(portalId, "contact", contactId),
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.getMeetings",
      details: { contactId },
      success: false,
      error: errMsg(err),
    });
    return { error: `Failed to fetch meetings: ${errMsg(err)}` };
  }
}

async function updateMeeting(
  ctx: ToolContext,
  apiKey: string,
  meetingId: string,
  properties: {
    hs_meeting_outcome: string | null;
    hs_meeting_start_time: string | null;
    hs_meeting_end_time: string | null;
    hs_meeting_title: string | null;
  } | null,
) {
  const filteredProperties: Record<string, string> = {};
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (value != null) {
        filteredProperties[key] = value;
      }
    }
  }

  if (Object.keys(filteredProperties).length === 0) {
    return {
      error:
        "Provide at least one property to update " +
        "(hs_meeting_outcome, hs_meeting_start_time, hs_meeting_end_time, hs_meeting_title).",
    };
  }

  try {
    const url = `https://api.hubapi.com/crm/v3/objects/meetings/${meetingId}`;

    const response = await hubspotFetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ properties: filteredProperties }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { error: `HubSpot API error (${response.status}): ${body.slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    ctx.audit.log({
      action: "crm.updateMeeting",
      details: {
        meetingId,
        updatedFields: Object.keys(filteredProperties),
      },
      success: true,
    });

    return {
      success: true,
      meeting: {
        id: data.id,
        title: data.properties.hs_meeting_title ?? null,
        outcome: data.properties.hs_meeting_outcome ?? null,
        startTime: data.properties.hs_meeting_start_time ?? null,
        endTime: data.properties.hs_meeting_end_time ?? null,
      },
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.updateMeeting",
      details: { meetingId },
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot update meeting failed: ${errMsg(err)}` };
  }
}
