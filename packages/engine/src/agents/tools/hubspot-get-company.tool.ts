// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { hubspotFetch, getHubSpotApiKeyOrError } from "./hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "./hubspot-portal.js";

const COMPANY_PROPERTIES = [
  "name",
  "domain",
  "industry",
  "numberofemployees",
  "annualrevenue",
  "city",
  "state",
  "country",
  "phone",
  "website",
  "description",
  "createdate",
  "hs_lastmodifieddate",
];

export default defineTool({
  name: "hubspotGetCompany",
  description:
    "Search companies in the HubSpot CRM by name or domain (at least one required).\n" +
    "Returns name, domain, industry, employee count, revenue and the portal URL.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  parameters: z.object({
      name: z
        .string()
        .nullable()
        .describe("Company name to search for (partial matches allowed)"),
      domain: z
        .string()
        .nullable()
        .describe("Web domain to search for (e.g. 'acme.com')"),
    }),
  execute: async (params: {
      name: string | null;
      domain: string | null;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      try {
        if (!params.name && !params.domain) {
          return { error: "Provide at least one search criterion: name or domain." };
        }

        const filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> = [];

        if (params.name) {
          filterGroups.push({
            filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: params.name }],
          });
        }
        if (params.domain) {
          filterGroups.push({
            filters: [{ propertyName: "domain", operator: "EQ", value: params.domain }],
          });
        }

        const response = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/objects/companies/search",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              filterGroups,
              properties: COMPANY_PROPERTIES,
              limit: 10,
            }),
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

        ctx.audit.log({
          action: "crm.searchCompanies",
          details: {
            ...(params.name ? { name: auditPreview(params.name) } : {}),
            ...(params.domain ? { domain: params.domain } : {}),
            resultCount: data.total,
          },
          success: true,
        });

        const portalId = await getHubSpotPortalId(apiKey);

        return {
          found: data.total,
          companies: data.results.map((c) => ({
            id: c.id,
            name: c.properties.name,
            domain: c.properties.domain,
            industry: c.properties.industry,
            employees: c.properties.numberofemployees,
            annualRevenue: c.properties.annualrevenue,
            city: c.properties.city,
            country: c.properties.country,
            phone: c.properties.phone,
            website: c.properties.website,
            url: hubspotUrl(portalId, "company", c.id),
          })),
        };
      } catch (err) {
        ctx.audit.log({
          action: "crm.searchCompanies",
          success: false,
          error: errMsg(err),
        });
        return { error: `HubSpot company search failed: ${errMsg(err)}` };
      }
    },
});
