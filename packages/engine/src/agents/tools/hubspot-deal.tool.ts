// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "./hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "./hubspot-portal.js";

export default defineTool({
  name: "hubspotDeal",
  description:
    "Manage deals in the HubSpot CRM: create, update or search deals (opportunities).\n" +
    "Use action 'create' for new deals, 'update' to modify existing deals, 'search' to query.\n" +
    "Do NOT use this tool to create contacts — use hubspotContact with action 'create'.\n" +
    "Returns the deal ID and its URL in the HubSpot portal.\n" +
    "Caveat: for 'create', stage must match a valid pipeline stage. contactId and companyId are optional for associations. For 'update', dealId is required — you can update stage, amount, closeDate, description. For 'search', closeDateAfter/Before filter by expected close date, NOT by creation date. The optional associatedContactId parameter filters deals belonging to a specific contact — useful to find purchase history of an existing customer. To read portal custom properties pass returnProperties (e.g. ['plan_tier','sla_class']) — values are exposed under customProperties on each deal. Stages: appointmentscheduled, qualifiedtobuy, presentationscheduled, decisionmakerboughtin, closedwon, closedlost.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Minimal deal",
      input: { action: "create", dealName: "Renewal — Acme Inc.", stage: "appointmentscheduled" },
    },
    {
      label: "Full deal with associations",
      input: { action: "create", dealName: "Premium Upgrade", stage: "qualifiedtobuy", amount: 5000, closeDate: "2026-06-30", contactId: "12345", companyId: "67890" },
    },
    {
      label: "Update a deal's stage",
      input: { action: "update", dealId: "496624375027", stage: "decisionmakerboughtin" },
    },
    {
      label: "All active deals (overview)",
      input: { action: "search" },
    },
    {
      label: "Deals in qualified stage within a close date range",
      input: { action: "search", stage: "qualifiedtobuy", closeDateAfter: "2026-04-01", closeDateBefore: "2026-06-30" },
    },
    {
      label: "Deals of a contact with custom properties",
      input: { action: "search", associatedContactId: "12345", stage: "closedwon", returnProperties: ["plan_tier", "sla_class"], limit: 1 },
    },
  ],
  parameters: z.object({
      action: z.enum(["create", "update", "search"]).describe("'create' for a new deal, 'update' to modify an existing deal, 'search' to query"),
      // --- update params ---
      dealId: z
        .string()
        .nullable()
        .describe("HubSpot deal ID to update (required for update)"),
      // --- create params ---
      dealName: z
        .string()
        .nullable()
        .describe("Deal name (required for create, e.g. 'Renewal — Acme Inc.')"),
      stage: z
        .string()
        .nullable()
        .describe("Pipeline stage (required for create, e.g. 'appointmentscheduled', 'qualifiedtobuy', 'closedwon')"),
      pipeline: z
        .string()
        .nullable()
        .describe("Pipeline ID. If null, uses the default pipeline."),
      amount: z
        .number()
        .nullable()
        .describe("Deal value"),
      closeDate: z
        .string()
        .nullable()
        .describe("Expected close date (ISO 8601). If null, not set."),
      contactId: z
        .string()
        .nullable()
        .describe("HubSpot contact ID to associate with the deal"),
      companyId: z
        .string()
        .nullable()
        .describe("HubSpot company ID to associate with the deal"),
      description: z
        .string()
        .nullable()
        .describe("Notes or deal description"),
      // --- search params ---
      query: z
        .string()
        .nullable()
        .describe("Free-text query against the deal name (search only)"),
      closeDateAfter: z
        .string()
        .nullable()
        .describe("Close date on or after this date (ISO 8601, search only)"),
      closeDateBefore: z
        .string()
        .nullable()
        .describe("Close date on or before this date (ISO 8601, search only)"),
      createdAfter: z
        .string()
        .nullable()
        .describe("Created on or after this date (ISO 8601, search only)"),
      limit: z
        .number()
        .nullable()
        .describe("Maximum number of results (default 20, max 100, search only)"),
      associatedContactId: z
        .string()
        .nullable()
        .describe("Filter deals associated with this HubSpot contactId (search only). Use to find purchase history of an existing customer."),
      returnProperties: z
        .array(z.string())
        .nullable()
        .describe(
          "Extra properties to include in the 'search' response (e.g. ['plan_tier','sla_class']). " +
          "The values are exposed under each deal's 'customProperties' field. " +
          "Ignored for create/update.",
        ),
    }),
  execute: async (params: {
      action: "create" | "update" | "search";
      dealId: string | null;
      dealName: string | null;
      stage: string | null;
      pipeline: string | null;
      amount: number | null;
      closeDate: string | null;
      contactId: string | null;
      companyId: string | null;
      description: string | null;
      query: string | null;
      closeDateAfter: string | null;
      closeDateBefore: string | null;
      createdAfter: string | null;
      limit: number | null;
      associatedContactId: string | null;
      returnProperties: string[] | null;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      if (params.action === "search") {
        return searchDeals(ctx, apiKey, params);
      }

      if (params.action === "update") {
        return updateDeal(ctx, apiKey, params);
      }

      return createDeal(ctx, apiKey, params);
    },
});

async function createDeal(
  ctx: ToolContext,
  apiKey: string,
  params: {
    dealName: string | null;
    stage: string | null;
    pipeline: string | null;
    amount: number | null;
    closeDate: string | null;
    contactId: string | null;
    companyId: string | null;
    description: string | null;
  },
) {
  if (!params.dealName || !params.stage) {
    return { error: "dealName and stage are required for action 'create'." };
  }

  try {
    const properties: Record<string, string> = {
      dealname: params.dealName,
      dealstage: params.stage,
    };

    if (params.pipeline) properties.pipeline = params.pipeline;
    if (params.amount != null) properties.amount = String(params.amount);
    if (params.closeDate) properties.closedate = params.closeDate;
    if (params.description) properties.description = params.description;

    const createResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/deals",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ properties }),
      },
    );

    if (!createResponse.ok) {
      const respBody = await createResponse.text();
      return { error: `Deal creation failed (${createResponse.status}): ${respBody.slice(0, 200)}` };
    }

    const deal = (await createResponse.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const warnings: string[] = [];

    if (params.contactId) {
      const assocRes = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/deals/contacts/batch/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: [
              {
                from: { id: deal.id },
                to: { id: params.contactId },
                type: HUBSPOT_ASSOCIATION_TYPES.dealToContact,
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

    if (params.companyId) {
      const assocRes = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/deals/companies/batch/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: [
              {
                from: { id: deal.id },
                to: { id: params.companyId },
                type: HUBSPOT_ASSOCIATION_TYPES.dealToCompany,
              },
            ],
          }),
        },
      );

      if (!assocRes.ok) {
        const body = await assocRes.text();
        warnings.push(`Company association failed: ${body.slice(0, 100)}`);
      }
    }

    ctx.audit.log({
      action: "crm.createDeal",
      details: {
        dealId: deal.id,
        dealName: auditPreview(params.dealName),
        stage: params.stage,
        amount: params.amount,
        contactId: params.contactId,
        companyId: params.companyId,
      },
      success: true,
    });

    const portalId = await getHubSpotPortalId(apiKey);

    return {
      success: true,
      deal: {
        id: deal.id,
        name: params.dealName,
        stage: params.stage,
        amount: params.amount,
        url: hubspotUrl(portalId, "deal", deal.id),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      message: "Deal created successfully.",
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.createDeal",
      details: { dealName: auditPreview(params.dealName!) },
      success: false,
      error: errMsg(err),
    });
    return { error: `Deal creation failed: ${errMsg(err)}` };
  }
}

async function updateDeal(
  ctx: ToolContext,
  apiKey: string,
  params: {
    dealId: string | null;
    dealName: string | null;
    stage: string | null;
    amount: number | null;
    closeDate: string | null;
    description: string | null;
    pipeline: string | null;
  },
) {
  if (!params.dealId) {
    return { error: "dealId is required for action 'update'." };
  }

  try {
    const properties: Record<string, string> = {};
    if (params.dealName) properties.dealname = params.dealName;
    if (params.stage) properties.dealstage = params.stage;
    if (params.pipeline) properties.pipeline = params.pipeline;
    if (params.amount != null) properties.amount = String(params.amount);
    if (params.closeDate) properties.closedate = params.closeDate;
    if (params.description) properties.description = params.description;

    if (Object.keys(properties).length === 0) {
      return { error: "Provide at least one field to update (stage, amount, closeDate, description, dealName)." };
    }

    const response = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${params.dealId}`,
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
      return { error: `Deal update failed (${response.status}): ${body.slice(0, 200)}` };
    }

    const deal = (await response.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const portalId = await getHubSpotPortalId(apiKey);

    ctx.audit.log({
      action: "crm.updateDeal",
      details: {
        dealId: params.dealId,
        updatedFields: Object.keys(properties),
      },
      success: true,
    });

    return {
      success: true,
      deal: {
        id: deal.id,
        name: deal.properties.dealname,
        stage: deal.properties.dealstage,
        amount: deal.properties.amount,
        closeDate: deal.properties.closedate,
        url: hubspotUrl(portalId, "deal", deal.id),
      },
      message: "Deal updated successfully.",
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.updateDeal",
      details: { dealId: params.dealId },
      success: false,
      error: errMsg(err),
    });
    return { error: `Deal update failed: ${errMsg(err)}` };
  }
}

async function searchDeals(
  ctx: ToolContext,
  apiKey: string,
  params: {
    query: string | null;
    stage: string | null;
    closeDateAfter: string | null;
    closeDateBefore: string | null;
    createdAfter: string | null;
    limit: number | null;
    associatedContactId: string | null;
    returnProperties: string[] | null;
  },
) {
  try {
    const filters: Array<{ propertyName: string; operator: string; value: string }> = [];

    if (params.stage) {
      filters.push({ propertyName: "dealstage", operator: "EQ", value: params.stage });
    }
    if (params.closeDateAfter) {
      filters.push({ propertyName: "closedate", operator: "GTE", value: params.closeDateAfter });
    }
    if (params.closeDateBefore) {
      filters.push({ propertyName: "closedate", operator: "LTE", value: params.closeDateBefore });
    }
    if (params.createdAfter) {
      filters.push({ propertyName: "createdate", operator: "GTE", value: params.createdAfter });
    }
    if (params.associatedContactId) {
      filters.push({ propertyName: "associations.contact", operator: "EQ", value: params.associatedContactId });
    }

    const baseProperties = [
      "dealname",
      "amount",
      "dealstage",
      "closedate",
      "createdate",
      "hs_lastmodifieddate",
      "description",
    ];
    const extraProperties = params.returnProperties ?? [];
    const allProperties = Array.from(new Set([...baseProperties, ...extraProperties]));

    const searchBody: Record<string, unknown> = {
      properties: allProperties,
      limit: Math.min(params.limit ?? 20, 100),
    };

    if (filters.length > 0) {
      searchBody.filterGroups = [{ filters }];
    }

    if (params.query) {
      searchBody.query = params.query;
    }

    const response = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/deals/search",
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

    const result = {
      found: data.total,
      deals: data.results.map((d) => {
        const customProperties: Record<string, string | null> = {};
        for (const key of extraProperties) {
          customProperties[key] = d.properties[key] ?? null;
        }
        return {
          id: d.id,
          name: d.properties.dealname,
          amount: d.properties.amount,
          stage: d.properties.dealstage,
          closeDate: d.properties.closedate,
          createdAt: d.properties.createdate,
          lastModified: d.properties.hs_lastmodifieddate,
          description: d.properties.description,
          url: hubspotUrl(portalId, "deal", d.id),
          ...(extraProperties.length > 0 ? { customProperties } : {}),
        };
      }),
    };

    ctx.audit.log({
      action: "crm.searchDeals",
      details: {
        ...(params.query ? { query: auditPreview(params.query) } : {}),
        ...(params.stage ? { stage: params.stage } : {}),
        resultCount: data.total,
      },
      success: true,
    });

    return result;
  } catch (err) {
    ctx.audit.log({
      action: "crm.searchDeals",
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot deal search failed: ${errMsg(err)}` };
  }
}
