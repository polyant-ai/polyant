// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { registerTool, type ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES, buildPhoneFilterGroups, resolveOwnerNames } from "./hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "./hubspot-portal.js";

const HUBSPOT_FILTER_OPERATORS = [
  "EQ",
  "NEQ",
  "HAS_PROPERTY",
  "NOT_HAS_PROPERTY",
  "CONTAINS_TOKEN",
  "GT",
  "GTE",
  "LT",
  "LTE",
] as const;

registerTool({
  name: "hubspotContact",
  description:
    "Create, update or search contacts in the HubSpot CRM (action: create | update | search).\n" +
    "For 'search' you need at least one of phone, name, email, contactId (= get-by-id) or filters; 'create' requires at least email or phone to avoid duplicates; 'update' requires contactId.\n" +
    "Portal custom properties: use customProperties in create/update, filters + returnProperties in search.\n" +
    "If the response includes nextAfter, repeat passing that value as 'after' to paginate.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Search by phone",
      input: { action: "search", phone: "+1 415 555 0100" },
    },
    {
      label: "Create a new contact",
      input: { action: "create", firstName: "Jane", lastName: "Doe", phone: "+1 415 555 0100", email: "jane.doe@example.com" },
    },
    {
      label: "Update the phone number of an existing contact",
      input: { action: "update", contactId: "12345", phone: "+1 415 555 0199" },
    },
    {
      label: "Create a contact with a custom property",
      input: {
        action: "create",
        firstName: "Jane",
        lastName: "Doe",
        phone: "+1 415 555 0100",
        email: "jane.doe@example.com",
        customProperties: { event: "spring-conference-2026" },
      },
    },
    {
      label: "Search all contacts for an event",
      input: {
        action: "search",
        filters: [{ property: "event", propertyName: null, operator: "EQ", value: "spring-conference-2026" }],
        returnProperties: ["event"],
        limit: 100,
      },
    },
    {
      label: "Next page of a search",
      input: {
        action: "search",
        filters: [{ property: "event", propertyName: null, operator: "EQ", value: "spring-conference-2026" }],
        limit: 100,
        after: "<nextAfter value from the previous call>",
      },
    },
    {
      label: "Get-by-id (search by contactId)",
      input: { action: "search", contactId: "12345" },
    },
  ],
  create: (ctx) => ({
    parameters: z.object({
      action: z.enum(["create", "update", "search"]).describe("'create' for a new contact, 'update' to modify an existing one, 'search' to query"),
      contactId: z
        .string()
        .nullable()
        .describe(
          "HubSpot contact ID. Required for 'update'. " +
          "Optional for 'search': when set it is treated as a get-by-id (filters on hs_object_id EQ).",
        ),
      firstName: z.string().nullable().describe("First name"),
      lastName: z.string().nullable().describe("Last name"),
      phone: z.string().nullable().describe("Phone number"),
      email: z.string().nullable().describe("Email address"),
      companyId: z
        .string()
        .nullable()
        .describe("HubSpot company ID to associate with the contact (optional, applies to 'create')"),
      name: z
        .string()
        .nullable()
        .describe("Name or surname to search by (only for action 'search')"),
      customProperties: z
        .record(z.string(), z.string())
        .nullable()
        .describe(
          "Arbitrary HubSpot properties to write on the contact (key = property internal name, value = string). " +
          "Use to populate custom properties already defined in the portal (e.g. { event: 'spring-conference-2026' }). " +
          "Not valid for action 'search'.",
        ),
      filters: z
        .array(
          z.preprocess(
            // Tolerate models that omit one of the two alias fields entirely
            // (instead of passing it as null). Without this, GPT-4.1-mini's
            // common shape `{ property: "...", operator, value }` would fail
            // the inner schema because `propertyName: z.string().nullable()`
            // rejects `undefined`. Filling missing keys with `null` keeps the
            // strict-mode-friendly schema unchanged while making the runtime
            // parse robust. See CLAUDE.md → "Tool parameter schemas".
            (raw) => {
              if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
              return { property: null, propertyName: null, ...(raw as Record<string, unknown>) };
            },
            z
              .object({
                // Field name is `property`. We ALSO accept `propertyName` (the
                // HubSpot REST API native name) because LLMs frequently emit
                // the latter due to their training priors on HubSpot docs.
                // Both forms are coerced to `property` in the transform below.
                // NOTE: we use `.nullable()` instead of `.optional()` because
                // OpenAI strict-mode (Responses API) rejects tool schemas with
                // properties not included in `required`. Runtime validation
                // below. See CLAUDE.md → "Important Caveats" and the
                // `strict-mode.test.ts` guard-rail.
                property: z.string().nullable(),
                propertyName: z.string().nullable(),
                operator: z.enum(HUBSPOT_FILTER_OPERATORS),
                value: z.string(),
              })
              .transform((f) => {
                const property = f.property ?? f.propertyName;
                if (!property) {
                  throw new Error(
                    "filters[].property is required (you can also pass it as 'propertyName')",
                  );
                }
                return { property, operator: f.operator, value: f.value };
              }),
          ),
        )
        .nullable()
        .describe(
          "Additional filters for action 'search'. AND-combined with phone/name/email when present, otherwise they form a single filterGroup. " +
          "The filter field is `property` (the `propertyName` alias is accepted for tolerance). " +
          "Supported operators: EQ, NEQ, HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN, GT, GTE, LT, LTE (single-value operators only — IN/NOT_IN not supported). " +
          "Example: [{ property: 'event', operator: 'EQ', value: 'spring-conference-2026' }]",
        ),
      returnProperties: z
        .array(z.string())
        .nullable()
        .describe(
          "Extra properties to include in the 'search' response (e.g. ['event']). " +
          "The values are exposed under each contact's 'customProperties' field. " +
          "Ignored for create/update.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe("Maximum number of results for 'search' (default 10, max 100). Ignored for create/update."),
      after: z
        .string()
        .nullable()
        .describe("HubSpot pagination cursor for 'search'. Pass the 'nextAfter' value from the previous call."),
    }),
    execute: async ({
      action,
      contactId,
      firstName,
      lastName,
      phone,
      email,
      companyId,
      name,
      customProperties,
      filters,
      returnProperties,
      limit,
      after,
    }: {
      action: "create" | "update" | "search";
      contactId: string | null;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
      email: string | null;
      companyId: string | null;
      name: string | null;
      customProperties: Record<string, string> | null;
      filters: Array<{ property: string; operator: (typeof HUBSPOT_FILTER_OPERATORS)[number]; value: string }> | null;
      returnProperties: string[] | null;
      limit: number | null;
      after: string | null;
    }) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      if (action === "search") {
        return searchContacts(ctx, apiKey, { contactId, phone, name, email, filters, returnProperties, limit, after });
      }

      return manageContact(ctx, apiKey, { action, contactId, firstName, lastName, phone, email, companyId, customProperties });
    },
  }),
});

async function searchContacts(
  ctx: ToolContext,
  apiKey: string,
  criteria: {
    contactId: string | null;
    phone: string | null;
    name: string | null;
    email: string | null;
    filters: Array<{ property: string; operator: (typeof HUBSPOT_FILTER_OPERATORS)[number]; value: string }> | null;
    returnProperties: string[] | null;
    limit: number | null;
    after: string | null;
  },
) {
  try {
    const filterGroups = buildFilterGroups(criteria);
    if (filterGroups.length === 0) {
      return { error: "Provide at least one search criterion: contactId, phone, name, email or filters." };
    }

    const baseProperties = ["firstname", "lastname", "phone", "mobilephone", "email", "hs_object_id", "hubspot_owner_id"];
    const extraProperties = criteria.returnProperties ?? [];
    const allProperties = Array.from(new Set([...baseProperties, ...extraProperties]));

    const effectiveLimit = Math.min(criteria.limit ?? 10, 100);

    const searchBody: Record<string, unknown> = {
      filterGroups,
      properties: allProperties,
      limit: effectiveLimit,
    };
    if (criteria.after) {
      searchBody.after = criteria.after;
    }

    const response = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
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
      paging?: { next?: { after?: string } };
    };

    const portalId = await getHubSpotPortalId(apiKey);

    // Resolve owner ids → name/email so callers see "Mario Rossi" instead of a
    // numeric id. Only hit the Owners API when at least one result carries an
    // owner (resolveOwnerNames also short-circuits on an empty id list).
    const ownerIds = data.results
      .map((c) => c.properties.hubspot_owner_id)
      .filter((id): id is string => Boolean(id));
    const owners = await resolveOwnerNames(apiKey, ownerIds);

    const result = {
      found: data.total,
      contacts: data.results.map((c) => {
        const customProperties: Record<string, string | null> = {};
        for (const key of extraProperties) {
          customProperties[key] = c.properties[key] ?? null;
        }
        const ownerId = c.properties.hubspot_owner_id ?? null;
        const owner = ownerId ? owners.get(ownerId) : undefined;
        return {
          id: c.id,
          firstName: c.properties.firstname ?? null,
          lastName: c.properties.lastname ?? null,
          phone: c.properties.phone ?? c.properties.mobilephone ?? null,
          email: c.properties.email ?? null,
          url: hubspotUrl(portalId, "contact", c.id),
          // hubspot_owner_id is retained for backward compatibility; owner_name
          // and owner_email are added only when the owner could be resolved.
          ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
          ...(owner ? { owner_name: owner.name, owner_email: owner.email } : {}),
          ...(extraProperties.length > 0 ? { customProperties } : {}),
        };
      }),
      ...(data.paging?.next?.after ? { nextAfter: data.paging.next.after } : {}),
    };

    ctx.audit.log({
      action: "crm.searchContacts",
      details: {
        ...(criteria.contactId ? { contactId: criteria.contactId } : {}),
        ...(criteria.phone ? { phone: auditPreview(criteria.phone) } : {}),
        ...(criteria.name ? { name: auditPreview(criteria.name) } : {}),
        ...(criteria.email ? { email: auditPreview(criteria.email) } : {}),
        ...(criteria.filters && criteria.filters.length > 0
          ? { customFilterProperties: criteria.filters.map((f) => f.property) }
          : {}),
        resultCount: data.total,
      },
      success: true,
    });

    return result;
  } catch (err) {
    ctx.audit.log({
      action: "crm.searchContacts",
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot search failed: ${errMsg(err)}` };
  }
}

function buildFilterGroups(criteria: {
  contactId: string | null;
  phone: string | null;
  name: string | null;
  email: string | null;
  filters: Array<{ property: string; operator: (typeof HUBSPOT_FILTER_OPERATORS)[number]; value: string }> | null;
}): Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> {
  const groups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> = [];

  if (criteria.contactId) {
    groups.push({
      filters: [{ propertyName: "hs_object_id", operator: "EQ", value: criteria.contactId }],
    });
  }

  if (criteria.phone) {
    groups.push(...buildPhoneFilterGroups(criteria.phone));
  }

  if (criteria.name) {
    const parts = criteria.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      groups.push({
        filters: [
          { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: parts[0] },
          { propertyName: "lastname", operator: "CONTAINS_TOKEN", value: parts.slice(1).join(" ") },
        ],
      });
    } else {
      groups.push({
        filters: [{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: parts[0] }],
      });
      groups.push({
        filters: [{ propertyName: "lastname", operator: "CONTAINS_TOKEN", value: parts[0] }],
      });
    }
  }

  if (criteria.email) {
    groups.push({
      filters: [{ propertyName: "email", operator: "EQ", value: criteria.email }],
    });
  }

  // Normalize custom filters to HubSpot shape
  const extraFilters = (criteria.filters ?? []).map((f) => ({
    propertyName: f.property,
    operator: f.operator,
    value: f.value,
  }));

  if (extraFilters.length > 0) {
    if (groups.length === 0) {
      // Standalone: single filterGroup with all filters AND-ed together
      groups.push({ filters: extraFilters });
    } else {
      // Combine: AND the custom filters into every existing group
      for (const g of groups) {
        g.filters.push(...extraFilters);
      }
    }
  }

  return groups;
}


async function manageContact(
  ctx: ToolContext,
  apiKey: string,
  params: {
    action: "create" | "update";
    contactId: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
    companyId: string | null;
    customProperties: Record<string, string> | null;
  },
) {
  const { action, contactId, firstName, lastName, phone, email, companyId, customProperties } = params;

  if (action === "update" && !contactId) {
    return { error: "contactId is required for action 'update'." };
  }

  // Basic email format validation
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (email && !EMAIL_RE.test(email)) {
    return { error: `Invalid email format: '${email}'.` };
  }

  try {
    const properties: Record<string, string> = {};
    if (firstName) properties.firstname = firstName;
    if (lastName) properties.lastname = lastName;
    if (phone) properties.phone = phone;
    if (email) properties.email = email;
    if (customProperties) {
      for (const [key, value] of Object.entries(customProperties)) {
        properties[key] = value;
      }
    }

    if (Object.keys(properties).length === 0) {
      return { error: "Provide at least one property (firstName, lastName, phone, email, customProperties)." };
    }

    let url: string;
    let method: string;

    if (action === "create") {
      url = "https://api.hubapi.com/crm/v3/objects/contacts";
      method = "POST";
    } else {
      url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;
      method = "PATCH";
    }

    const response = await hubspotFetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ properties }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { error: `HubSpot API error (${response.status}): ${body.slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const warnings: string[] = [];

    // Associate with company (type 1 = contact-to-company) — only on create
    if (companyId && action === "create") {
      const assocRes = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/contacts/companies/batch/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: [
              {
                from: { id: data.id },
                to: { id: companyId },
                type: HUBSPOT_ASSOCIATION_TYPES.contactToCompany,
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

    const portalId = await getHubSpotPortalId(apiKey);

    const result = {
      success: true,
      action,
      contact: {
        id: data.id,
        firstName: data.properties.firstname ?? null,
        lastName: data.properties.lastname ?? null,
        phone: data.properties.phone ?? null,
        email: data.properties.email ?? null,
        url: hubspotUrl(portalId, "contact", data.id),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    ctx.audit.log({
      action: action === "create" ? "crm.createContact" : "crm.updateContact",
      details: {
        contactId: data.id,
        fieldsChanged: Object.keys(properties),
        companyId: companyId ?? undefined,
        ...(customProperties ? { customPropertyKeys: Object.keys(customProperties) } : {}),
      },
      success: true,
    });

    return result;
  } catch (err) {
    ctx.audit.log({
      action: action === "create" ? "crm.createContact" : "crm.updateContact",
      details: { ...(contactId ? { contactId } : {}) },
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot ${action} failed: ${errMsg(err)}` };
  }
}
