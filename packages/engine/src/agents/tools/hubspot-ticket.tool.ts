// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { type ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "./hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "./hubspot-portal.js";

export default defineTool({
  name: "hubspotTicket",
  description:
    "Manage tickets in the HubSpot CRM: create, update, fetch details or search tickets.\n" +
    "Use action 'create' for new tickets, 'update' to change priority/content/stage of an existing ticket, 'get' for ticket details (including associated contacts and companies), 'search' to query tickets (associated companies included in the response).\n" +
    "Returns ticket properties and its URL in the HubSpot portal.\n" +
    "Caveat: for 'create', subject is required. priority: HIGH, MEDIUM, LOW. contactId is optional for associations. For 'update', ticketId is required and at least one of priority/content/pipelineStage. For 'get', ticketId is required. For 'search', createdAfter/Before are ISO 8601, contactId filters tickets associated with that contact, openOnly=true excludes closed tickets (stage '4'). The query field searches in the subject and content.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Create a support ticket",
      input: { action: "create", subject: "Login fails after password reset", priority: "HIGH", content: "Customer reports being unable to log in after using the reset link", contactId: "12345" },
    },
    {
      label: "Bump priority of an existing ticket",
      input: { action: "update", ticketId: "12345", priority: "HIGH" },
    },
    {
      label: "Details of a specific ticket",
      input: { action: "get", ticketId: "12345" },
    },
    {
      label: "High-priority tickets created in the last week",
      input: { action: "search", priority: "HIGH", createdAfter: "2026-04-01" },
    },
    {
      label: "Open tickets of a contact",
      input: { action: "search", contactId: "12345", openOnly: true },
    },
  ],
  parameters: z.object({
    action: z.enum(["create", "update", "get", "search"]).describe("'create' for a new ticket, 'update' to modify an existing ticket, 'get' for details of a single ticket, 'search' to query"),
    // --- create / update params ---
    subject: z
      .string()
      .nullable()
      .describe("Ticket subject (required for create)"),
    content: z
      .string()
      .nullable()
      .describe("Ticket description/content (optional for create and update)"),
    contactId: z
      .string()
      .nullable()
      .describe("HubSpot contact ID. For create: associates the contact with the new ticket. For search: filters to tickets associated with this contact only."),
    pipelineStage: z
      .string()
      .nullable()
      .describe("Ticket pipeline stage (e.g. '1'=New, '2'=Waiting on contact, '3'=Waiting on us, '4'=Closed). Optional for create and update."),
    // --- get / update params ---
    ticketId: z
      .string()
      .nullable()
      .describe("HubSpot ticket ID (required for get and update)"),
    // --- search params ---
    query: z
      .string()
      .nullable()
      .describe("Free-text query against the ticket subject or content (search only)"),
    priority: z
      .enum(["LOW", "MEDIUM", "HIGH"])
      .nullable()
      .describe("For search: filter by ticket priority. For create/update: priority to set."),
    createdAfter: z
      .string()
      .nullable()
      .describe("Tickets created on or after this date (ISO 8601, search only)"),
    createdBefore: z
      .string()
      .nullable()
      .describe("Tickets created on or before this date (ISO 8601, search only)"),
    openOnly: z
      .boolean()
      .nullable()
      .describe("When true, excludes closed tickets (stage '4'). Search only."),
    limit: z
      .number()
      .nullable()
      .describe("Maximum number of results (default 20, max 100, search only)"),
  }),
  execute: async (
    params: {
      action: "create" | "update" | "get" | "search";
      subject: string | null;
      content: string | null;
      contactId: string | null;
      pipelineStage: string | null;
      ticketId: string | null;
      query: string | null;
      priority: "LOW" | "MEDIUM" | "HIGH" | null;
      createdAfter: string | null;
      createdBefore: string | null;
      openOnly: boolean | null;
      limit: number | null;
    },
    ctx: ToolContext,
  ) => {
    const apiKeyResult = getHubSpotApiKeyOrError(ctx);
    if (typeof apiKeyResult !== "string") return apiKeyResult;
    const apiKey = apiKeyResult;

    if (params.action === "create") {
      return createTicket(ctx, apiKey, params);
    }

    if (params.action === "update") {
      if (!params.ticketId) {
        return { error: "ticketId is required for action 'update'." };
      }
      return updateTicket(ctx, apiKey, params);
    }

    if (params.action === "get") {
      if (!params.ticketId) {
        return { error: "ticketId is required for action 'get'." };
      }
      return getTicket(ctx, apiKey, params.ticketId);
    }

    return searchTickets(ctx, apiKey, params);
  },
});

// ---------------------------------------------------------------------------
// create logic
// ---------------------------------------------------------------------------

async function createTicket(
  ctx: ToolContext,
  apiKey: string,
  params: {
    subject: string | null;
    content: string | null;
    priority: "LOW" | "MEDIUM" | "HIGH" | null;
    contactId: string | null;
  },
) {
  if (!params.subject) {
    return { error: "subject is required for action 'create'." };
  }

  try {
    const properties: Record<string, string> = {
      subject: params.subject,
      hs_pipeline: "0",
      hs_pipeline_stage: "1",
    };

    if (params.content) properties.content = params.content;
    if (params.priority) properties.hs_ticket_priority = params.priority;

    const response = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/tickets",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ properties }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return { error: `Ticket creation failed (${response.status}): ${body.slice(0, 200)}` };
    }

    const ticket = (await response.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const warnings: string[] = [];

    // Associate with contact (type 16 = ticket-to-contact)
    if (params.contactId) {
      const assocRes = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/tickets/contacts/batch/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: [
              {
                from: { id: ticket.id },
                to: { id: params.contactId },
                type: HUBSPOT_ASSOCIATION_TYPES.ticketToContact,
              },
            ],
          }),
        },
      );

      if (!assocRes.ok) {
        const body = await assocRes.text();
        warnings.push(`Contact association failed: ${body.slice(0, 100)}`);
      }
    }

    const portalId = await getHubSpotPortalId(apiKey);

    ctx.audit.log({
      action: "crm.createTicket",
      details: {
        ticketId: ticket.id,
        subject: auditPreview(params.subject),
        priority: params.priority,
        contactId: params.contactId,
      },
      success: true,
    });

    return {
      success: true,
      ticket: {
        id: ticket.id,
        subject: params.subject,
        priority: params.priority,
        url: hubspotUrl(portalId, "ticket", ticket.id),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      message: "Ticket creato con successo.",
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.createTicket",
      details: { subject: auditPreview(params.subject!) },
      success: false,
      error: errMsg(err),
    });
    return { error: `Ticket creation failed: ${errMsg(err)}` };
  }
}

// ---------------------------------------------------------------------------
// update logic
// ---------------------------------------------------------------------------

async function updateTicket(
  ctx: ToolContext,
  apiKey: string,
  params: {
    ticketId: string | null;
    priority: "LOW" | "MEDIUM" | "HIGH" | null;
    content: string | null;
    pipelineStage: string | null;
  },
) {
  const ticketId = params.ticketId!;
  const properties: Record<string, string> = {};
  if (params.priority) properties.hs_ticket_priority = params.priority;
  if (params.content !== null) properties.content = params.content;
  if (params.pipelineStage) properties.hs_pipeline_stage = params.pipelineStage;

  if (Object.keys(properties).length === 0) {
    return { error: "For 'update' provide at least one of priority, content, pipelineStage." };
  }

  // Snapshot of current properties to log the diff (best-effort)
  let previousPriority: string | null = null;
  let previousStage: string | null = null;
  try {
    const beforeRes = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}?properties=hs_ticket_priority,hs_pipeline_stage`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    if (beforeRes.ok) {
      const beforeData = (await beforeRes.json()) as { properties?: Record<string, string | null> };
      previousPriority = beforeData.properties?.hs_ticket_priority ?? null;
      previousStage = beforeData.properties?.hs_pipeline_stage ?? null;
    }
  } catch {
    // diff snapshot best-effort: se fallisce procediamo senza
  }

  try {
    const response = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ properties }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      ctx.audit.log({
        action: "crm.updateTicket",
        details: { ticketId, properties: Object.keys(properties) },
        success: false,
        error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
      });
      return { error: `Ticket update failed (${response.status}): ${body.slice(0, 200)}` };
    }

    const ticket = (await response.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const portalId = await getHubSpotPortalId(apiKey);

    ctx.audit.log({
      action: "crm.updateTicket",
      details: {
        ticketId,
        priority: params.priority
          ? { from: previousPriority, to: params.priority }
          : undefined,
        pipelineStage: params.pipelineStage
          ? { from: previousStage, to: params.pipelineStage }
          : undefined,
        contentUpdated: params.content !== null ? true : undefined,
      },
      success: true,
    });

    return {
      success: true,
      ticket: {
        id: ticket.id,
        priority: ticket.properties.hs_ticket_priority,
        stage: ticket.properties.hs_pipeline_stage,
        url: hubspotUrl(portalId, "ticket", ticket.id),
      },
      previous: {
        priority: previousPriority,
        stage: previousStage,
      },
      message: "Ticket aggiornato con successo.",
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.updateTicket",
      details: { ticketId, properties: Object.keys(properties) },
      success: false,
      error: errMsg(err),
    });
    return { error: `Ticket update failed: ${errMsg(err)}` };
  }
}

// ---------------------------------------------------------------------------
// shared: fetch associated companies for a batch of ticket IDs
// ---------------------------------------------------------------------------

interface CompanyInfo {
  id: string;
  name: string | null;
  domain: string | null;
  industry: string | null;
  url: string | null;
}

async function fetchAssociatedCompanies(
  apiKey: string,
  ticketIds: string[],
  portalId: string | null,
): Promise<Map<string, CompanyInfo[]>> {
  const result = new Map<string, CompanyInfo[]>();
  if (ticketIds.length === 0) return result;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // 1. Batch-read ticket→company associations
  const assocRes = await hubspotFetch(
    "https://api.hubapi.com/crm/v4/associations/tickets/companies/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: ticketIds.map((id) => ({ id })),
      }),
    },
  );

  if (!assocRes.ok) return result;

  const assocData = (await assocRes.json()) as {
    results: Array<{
      from: { id: string };
      to: Array<{ toObjectId: number }>;
    }>;
  };

  // Collect all unique company IDs and build ticket→companyIds map
  const companyIdSet = new Set<string>();
  const ticketToCompanyIds = new Map<string, string[]>();

  for (const entry of assocData.results) {
    const tId = entry.from.id;
    const cIds = entry.to.map((t) => String(t.toObjectId));
    ticketToCompanyIds.set(tId, cIds);
    for (const cId of cIds) companyIdSet.add(cId);
  }

  if (companyIdSet.size === 0) return result;

  // 2. Batch-read company details
  const batchRes = await hubspotFetch(
    "https://api.hubapi.com/crm/v3/objects/companies/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: [...companyIdSet].map((id) => ({ id })),
        properties: ["name", "domain", "industry"],
      }),
    },
  );

  if (!batchRes.ok) return result;

  const batchData = (await batchRes.json()) as {
    results: Array<{ id: string; properties: Record<string, string | null> }>;
  };

  const companyMap = new Map<string, CompanyInfo>();
  for (const c of batchData.results) {
    companyMap.set(c.id, {
      id: c.id,
      name: c.properties.name,
      domain: c.properties.domain,
      industry: c.properties.industry,
      url: hubspotUrl(portalId, "company", c.id),
    });
  }

  // 3. Build result map: ticketId → CompanyInfo[]
  for (const [tId, cIds] of ticketToCompanyIds) {
    const companies: CompanyInfo[] = [];
    for (const cId of cIds) {
      const info = companyMap.get(cId);
      if (info) companies.push(info);
    }
    if (companies.length > 0) result.set(tId, companies);
  }

  return result;
}

async function getTicket(
  ctx: ToolContext,
  apiKey: string,
  ticketId: string,
) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  try {
    // 1. Get ticket with properties
    const ticketRes = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}?properties=subject,content,hs_pipeline,hs_pipeline_stage,hs_ticket_priority,createdate,hs_lastmodifieddate`,
      { headers },
    );

    if (!ticketRes.ok) {
      const body = await ticketRes.text();
      return { error: `Ticket fetch failed (${ticketRes.status}): ${body.slice(0, 200)}` };
    }

    const ticket = (await ticketRes.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    // 2. Get associated contacts
    const assocRes = await hubspotFetch(
      `https://api.hubapi.com/crm/v4/objects/tickets/${ticketId}/associations/contacts`,
      { headers },
    );

    const contactIds: string[] = [];
    if (assocRes.ok) {
      const assocData = (await assocRes.json()) as { results: Array<{ toObjectId: number }> };
      for (const r of assocData.results) {
        contactIds.push(String(r.toObjectId));
      }
    }

    // 3. Fetch contact details with annual revenue
    const contacts: Array<{ id: string; properties: Record<string, string | null> }> = [];
    if (contactIds.length > 0) {
      const batchRes = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            inputs: contactIds.map((id) => ({ id })),
            properties: ["firstname", "lastname", "email", "phone", "company", "annualrevenue", "hs_lead_status"],
          }),
        },
      );

      if (batchRes.ok) {
        const batchData = (await batchRes.json()) as { results: Array<{ id: string; properties: Record<string, string | null> }> };
        contacts.push(...batchData.results);
      }
    }

    const portalId = await getHubSpotPortalId(apiKey);

    // 4. Fetch associated companies
    const companiesMap = await fetchAssociatedCompanies(apiKey, [ticketId], portalId);
    const companies = companiesMap.get(ticketId) ?? [];

    const result = {
      ticket: {
        id: ticket.id,
        subject: ticket.properties.subject,
        content: ticket.properties.content,
        pipeline: ticket.properties.hs_pipeline,
        stage: ticket.properties.hs_pipeline_stage,
        priority: ticket.properties.hs_ticket_priority,
        createdAt: ticket.properties.createdate,
        url: hubspotUrl(portalId, "ticket", ticket.id),
      },
      companies,
      contacts: contacts.map((c) => ({
        id: c.id,
        name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" "),
        email: c.properties.email,
        phone: c.properties.phone,
        company: c.properties.company,
        annualRevenue: c.properties.annualrevenue,
        leadStatus: c.properties.hs_lead_status,
        url: hubspotUrl(portalId, "contact", c.id),
      })),
    };

    ctx.audit.log({
      action: "crm.getTicket",
      details: { ticketId, contactCount: contacts.length, companyCount: companies.length },
      success: true,
    });

    return result;
  } catch (err) {
    ctx.audit.log({
      action: "crm.getTicket",
      details: { ticketId },
      success: false,
      error: errMsg(err),
    });
    return { error: `Ticket fetch failed: ${errMsg(err)}` };
  }
}

async function searchTickets(
  ctx: ToolContext,
  apiKey: string,
  params: {
    query: string | null;
    priority: "LOW" | "MEDIUM" | "HIGH" | null;
    createdAfter: string | null;
    createdBefore: string | null;
    contactId: string | null;
    openOnly: boolean | null;
    limit: number | null;
  },
) {
  try {
    const filters: Array<{ propertyName: string; operator: string; value: string }> = [];

    if (params.priority) {
      filters.push({ propertyName: "hs_ticket_priority", operator: "EQ", value: params.priority });
    }
    if (params.createdAfter) {
      filters.push({ propertyName: "createdate", operator: "GTE", value: params.createdAfter });
    }
    if (params.createdBefore) {
      filters.push({ propertyName: "createdate", operator: "LTE", value: params.createdBefore });
    }
    if (params.contactId) {
      filters.push({ propertyName: "associations.contact", operator: "EQ", value: params.contactId });
    }
    if (params.openOnly) {
      // The standard HubSpot support pipeline (id "0") closes at stage "4".
      // For custom pipelines you'd need the actual closed stage id; this filter
      // is a heuristic tailored to the most common default-support pipeline case.
      filters.push({ propertyName: "hs_pipeline_stage", operator: "NEQ", value: "4" });
    }

    const searchBody: Record<string, unknown> = {
      properties: [
        "subject",
        "content",
        "hs_ticket_priority",
        "hs_pipeline",
        "hs_pipeline_stage",
        "createdate",
        "hs_lastmodifieddate",
        "hs_ticket_category",
      ],
      limit: Math.min(params.limit ?? 20, 100),
    };

    if (filters.length > 0) {
      searchBody.filterGroups = [{ filters }];
    }

    if (params.query) {
      searchBody.query = params.query;
    }

    const response = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/tickets/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(searchBody),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return { error: `HubSpot API error (${response.status}): ${body.slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      total: number;
      results: Array<{
        id: string;
        properties: Record<string, string | null>;
      }>;
    };

    const portalId = await getHubSpotPortalId(apiKey);

    // Fetch associated companies for all tickets in batch
    const ticketIds = data.results.map((t) => t.id);
    const companiesMap = await fetchAssociatedCompanies(apiKey, ticketIds, portalId);

    const result = {
      found: data.total,
      tickets: data.results.map((t) => ({
        id: t.id,
        subject: t.properties.subject,
        content: t.properties.content,
        priority: t.properties.hs_ticket_priority,
        pipeline: t.properties.hs_pipeline,
        stage: t.properties.hs_pipeline_stage,
        category: t.properties.hs_ticket_category,
        createdAt: t.properties.createdate,
        lastModified: t.properties.hs_lastmodifieddate,
        url: hubspotUrl(portalId, "ticket", t.id),
        companies: companiesMap.get(t.id) ?? [],
      })),
    };

    ctx.audit.log({
      action: "crm.searchTickets",
      details: {
        ...(params.query ? { query: auditPreview(params.query) } : {}),
        ...(params.priority ? { priority: params.priority } : {}),
        ...(params.contactId ? { contactId: params.contactId } : {}),
        ...(params.openOnly ? { openOnly: true } : {}),
        resultCount: data.total,
      },
      success: true,
    });

    return result;
  } catch (err) {
    ctx.audit.log({
      action: "crm.searchTickets",
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot ticket search failed: ${errMsg(err)}` };
  }
}
