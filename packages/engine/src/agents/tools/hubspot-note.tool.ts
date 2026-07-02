// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES, resolveContactIdFromPhone } from "./hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "./hubspot-portal.js";
import { ensureHtmlBody } from "./hubspot-rich-text.js";

export default defineTool({
  name: "hubspotNote",
  description:
    "Manage notes in the HubSpot CRM (action: create | search | update).\n" +
    "To identify the contact you can pass contactId OR phone (E.164, e.g. '+14155550100'): if you only pass phone, the tool resolves the contactId automatically.\n" +
    "In 'search' with contactId/phone you only get the notes for that contact. In 'update' pass noteId and body (overwrites the previous body).\n" +
    "For an updatable contact profile: search → create if missing, update if present. Never duplicate.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Note associated with contact and deal (via contactId)",
      input: { action: "create", body: "Brief: the contact is interested in the Premium plan", contactId: "12345", dealId: "67890" },
    },
    {
      label: "Search notes of a contact identified by phone",
      input: { action: "search", phone: "+14155550100", query: "[CONTACT_PROFILE]", limit: 5 },
    },
    {
      label: "Create note associated with contact identified by phone",
      input: { action: "create", body: "<p>…</p>", phone: "+14155550100" },
    },
    {
      label: "Update body of an existing note",
      input: { action: "update", noteId: "987654321", body: "[CONTACT_PROFILE]\nLast updated: 2026-04-20\nPreferences: vegan" },
    },
  ],
  parameters: z.object({
      action: z.enum(["create", "search", "update"]).describe("'create' for a new note, 'search' to query, 'update' to modify an existing note"),
      // --- create + update params ---
      body: z
        .string()
        .nullable()
        .describe("Note body (required for create and update). For update, overwrites the previous body."),
      noteId: z
        .string()
        .nullable()
        .describe("Note ID to update (required for update)"),
      contactId: z
        .string()
        .nullable()
        .describe("HubSpot contact ID. For 'create' = association; for 'search' = server-side filter (returns ONLY notes associated with this contact). Alternative: pass 'phone' and the tool resolves contactId automatically."),
      phone: z
        .string()
        .nullable()
        .describe("Contact phone in E.164 format (e.g. '+14155550100'). Alternative to contactId for 'search' and 'create': the tool performs the lookup internally. Ignored when contactId is already provided. Ignored for 'update'."),
      dealId: z
        .string()
        .nullable()
        .describe("HubSpot deal ID to associate with (create only)"),
      companyId: z
        .string()
        .nullable()
        .describe("HubSpot company ID to associate with (create only)"),
      ticketId: z
        .string()
        .nullable()
        .describe("HubSpot ticket ID to associate with (create only)"),
      // --- search params ---
      query: z
        .string()
        .nullable()
        .describe("Free-text search inside note bodies (search only)"),
      createdAfter: z
        .string()
        .nullable()
        .describe("Notes created after this date (ISO 8601, search only)"),
      createdBefore: z
        .string()
        .nullable()
        .describe("Notes created before this date (ISO 8601, search only)"),
      limit: z
        .number()
        .nullable()
        .describe("Maximum number of results (default 20, max 100, search only)"),
    }),
  execute: async (params: {
      action: "create" | "search" | "update";
      body: string | null;
      noteId: string | null;
      contactId: string | null;
      phone: string | null;
      dealId: string | null;
      companyId: string | null;
      ticketId: string | null;
      query: string | null;
      createdAfter: string | null;
      createdBefore: string | null;
      limit: number | null;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      // If caller gave phone but no contactId, resolve phone→contactId once
      // so downstream logic can treat the two paths uniformly.
      let resolvedContactId = params.contactId;
      if (!resolvedContactId && params.phone && params.action !== "update") {
        resolvedContactId = await resolveContactIdFromPhone(apiKey, params.phone);
        if (!resolvedContactId) {
          return { error: `No contact found in HubSpot with phone "${params.phone}".` };
        }
      }
      const paramsWithResolvedContact = { ...params, contactId: resolvedContactId };

      if (params.action === "search") {
        return searchNotes(ctx, apiKey, paramsWithResolvedContact);
      }

      if (params.action === "update") {
        return updateNote(ctx, apiKey, paramsWithResolvedContact);
      }

      return createNote(ctx, apiKey, paramsWithResolvedContact);
    },
});

async function createNote(
  ctx: ToolContext,
  apiKey: string,
  params: {
    body: string | null;
    contactId: string | null;
    dealId: string | null;
    companyId: string | null;
    ticketId: string | null;
  },
) {
  if (!params.body) {
    return { error: "body is required for action 'create'." };
  }

  try {
    // 1. Create the note
    const createResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/notes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          properties: {
            // HubSpot renders note body as HTML. Auto-convert plain-text
            // newlines to <br> so LLM-emitted bodies stay readable.
            hs_note_body: ensureHtmlBody(params.body),
            hs_timestamp: new Date().toISOString(),
          },
        }),
      },
    );

    if (!createResponse.ok) {
      const respBody = await createResponse.text();
      return { error: `Note creation failed (${createResponse.status}): ${respBody.slice(0, 200)}` };
    }

    const note = (await createResponse.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const warnings: string[] = [];
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    // 2. Associate with contact (type 202 = note-to-contact)
    if (params.contactId) {
      const res = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/notes/contacts/batch/create",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            inputs: [{ from: { id: note.id }, to: { id: params.contactId }, type: HUBSPOT_ASSOCIATION_TYPES.noteToContact }],
          }),
        },
      );
      if (!res.ok) {
        const b = await res.text();
        warnings.push(`Contact association failed: ${b.slice(0, 100)}`);
      }
    }

    // 3. Associate with deal (type 214 = note-to-deal)
    if (params.dealId) {
      const res = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/notes/deals/batch/create",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            inputs: [{ from: { id: note.id }, to: { id: params.dealId }, type: HUBSPOT_ASSOCIATION_TYPES.noteToDeal }],
          }),
        },
      );
      if (!res.ok) {
        const b = await res.text();
        warnings.push(`Deal association failed: ${b.slice(0, 100)}`);
      }
    }

    // 4. Associate with company (type 190 = note-to-company)
    if (params.companyId) {
      const res = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/notes/companies/batch/create",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            inputs: [{ from: { id: note.id }, to: { id: params.companyId }, type: HUBSPOT_ASSOCIATION_TYPES.noteToCompany }],
          }),
        },
      );
      if (!res.ok) {
        const b = await res.text();
        warnings.push(`Company association failed: ${b.slice(0, 100)}`);
      }
    }

    // 5. Associate with ticket (type 18 = note-to-ticket)
    if (params.ticketId) {
      const res = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/notes/tickets/batch/create",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            inputs: [{ from: { id: note.id }, to: { id: params.ticketId }, type: HUBSPOT_ASSOCIATION_TYPES.noteToTicket }],
          }),
        },
      );
      if (!res.ok) {
        const b = await res.text();
        warnings.push(`Ticket association failed: ${b.slice(0, 100)}`);
      }
    }

    ctx.audit.log({
      action: "crm.createNote",
      details: {
        noteId: note.id,
        body: auditPreview(params.body),
        contactId: params.contactId,
        dealId: params.dealId,
        companyId: params.companyId,
        ticketId: params.ticketId,
      },
      success: true,
    });

    const needsPortal = Boolean(params.dealId || params.contactId);
    const portalId = needsPortal ? await getHubSpotPortalId(apiKey) : null;

    return {
      success: true,
      note: {
        id: note.id,
        ...(params.dealId ? { dealUrl: hubspotUrl(portalId, "deal", params.dealId) } : {}),
        ...(params.contactId ? { contactUrl: hubspotUrl(portalId, "contact", params.contactId) } : {}),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      message: "Note created and associated successfully.",
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.createNote",
      details: { body: auditPreview(params.body!) },
      success: false,
      error: errMsg(err),
    });
    return { error: `Note creation failed: ${errMsg(err)}` };
  }
}

async function searchNotes(
  ctx: ToolContext,
  apiKey: string,
  params: {
    contactId: string | null;
    query: string | null;
    createdAfter: string | null;
    createdBefore: string | null;
    limit: number | null;
  },
) {
  try {
    const limit = Math.min(params.limit ?? 20, 100);
    let noteIds: string[] = [];
    let matchedNotes: Array<{ id: string; properties: Record<string, string | null> }> = [];
    let total = 0;

    if (params.contactId) {
      // Contact-scoped search: use the associations API to list notes linked to
      // the contact (server-side scope), then batch-read + client-side query filter.
      const assocRes = await hubspotFetch(
        `https://api.hubapi.com/crm/v4/objects/contacts/${params.contactId}/associations/notes?limit=500`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      );
      if (!assocRes.ok) {
        const body = await assocRes.text();
        return { error: `HubSpot API error (${assocRes.status}) fetching contact note associations: ${body.slice(0, 200)}` };
      }
      const assocData = (await assocRes.json()) as {
        results: Array<{ toObjectId: string }>;
      };
      noteIds = assocData.results.map((r) => r.toObjectId);
      total = noteIds.length;

      if (noteIds.length === 0) {
        return { found: 0, notes: [] };
      }

      // Batch-read note bodies in parallel (HubSpot batch read max 100 per call)
      const chunks: string[][] = [];
      for (let i = 0; i < noteIds.length; i += 100) {
        chunks.push(noteIds.slice(i, i + 100));
      }
      const readResponses = await Promise.all(
        chunks.map((chunk) =>
          hubspotFetch(
            "https://api.hubapi.com/crm/v3/objects/notes/batch/read",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                properties: ["hs_note_body", "hs_timestamp", "hs_lastmodifieddate", "hubspot_owner_id"],
                inputs: chunk.map((id) => ({ id })),
              }),
            },
          ),
        ),
      );
      for (const readRes of readResponses) {
        if (!readRes.ok) {
          const body = await readRes.text();
          return { error: `HubSpot API error (${readRes.status}) batch-reading notes: ${body.slice(0, 200)}` };
        }
        const readData = (await readRes.json()) as {
          results: Array<{ id: string; properties: Record<string, string | null> }>;
        };
        matchedNotes.push(...readData.results);
      }

      // Apply client-side filters (query substring, date bounds) and sort desc by timestamp
      if (params.query) {
        const needle = params.query.toLowerCase();
        matchedNotes = matchedNotes.filter((n) => (n.properties.hs_note_body ?? "").toLowerCase().includes(needle));
      }
      if (params.createdAfter) {
        const afterMs = Date.parse(params.createdAfter);
        matchedNotes = matchedNotes.filter((n) => {
          const ts = Date.parse(n.properties.hs_timestamp ?? "");
          return !isNaN(ts) && ts >= afterMs;
        });
      }
      if (params.createdBefore) {
        const beforeMs = Date.parse(params.createdBefore);
        matchedNotes = matchedNotes.filter((n) => {
          const ts = Date.parse(n.properties.hs_timestamp ?? "");
          return !isNaN(ts) && ts <= beforeMs;
        });
      }
      matchedNotes.sort((a, b) => {
        const ta = Date.parse(a.properties.hs_timestamp ?? "") || 0;
        const tb = Date.parse(b.properties.hs_timestamp ?? "") || 0;
        return tb - ta;
      });
      matchedNotes = matchedNotes.slice(0, limit);
      total = matchedNotes.length;
    } else {
      // Global search (legacy path) — unchanged.
      const filters: Array<{ propertyName: string; operator: string; value: string }> = [];
      if (params.createdAfter) {
        filters.push({ propertyName: "hs_timestamp", operator: "GTE", value: params.createdAfter });
      }
      if (params.createdBefore) {
        filters.push({ propertyName: "hs_timestamp", operator: "LTE", value: params.createdBefore });
      }

      const searchBody: Record<string, unknown> = {
        properties: [
          "hs_note_body",
          "hs_timestamp",
          "hs_lastmodifieddate",
          "hubspot_owner_id",
        ],
        sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
        limit,
      };

      if (filters.length > 0) {
        searchBody.filterGroups = [{ filters }];
      }
      if (params.query) {
        searchBody.query = params.query;
      }

      const response = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/objects/notes/search",
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
        results: Array<{ id: string; properties: Record<string, string | null> }>;
      };
      matchedNotes = data.results;
      total = data.total;
    }

    // Batch-fetch associations for matched notes (3 calls total)
    noteIds = matchedNotes.map((n) => n.id);
    const associationMap = await fetchBatchAssociations(apiKey, noteIds);
    const data = { total, results: matchedNotes };

    const portalId = await getHubSpotPortalId(apiKey);

    const notes = data.results.map((note) => {
      const assoc = associationMap.get(note.id) ?? { contactIds: [], dealIds: [], companyIds: [] };
      return {
        id: note.id,
        body: note.properties.hs_note_body,
        createdAt: note.properties.hs_timestamp,
        lastModified: note.properties.hs_lastmodifieddate,
        ownerId: note.properties.hubspot_owner_id,
        contactIds: assoc.contactIds,
        dealIds: assoc.dealIds,
        companyIds: assoc.companyIds,
        contactUrls: assoc.contactIds.map((id) => hubspotUrl(portalId, "contact", id)).filter(Boolean),
        dealUrls: assoc.dealIds.map((id) => hubspotUrl(portalId, "deal", id)).filter(Boolean),
      };
    });

    ctx.audit.log({
      action: "crm.searchNotes",
      details: {
        ...(params.query ? { query: params.query.slice(0, 50) } : {}),
        resultCount: data.total,
      },
      success: true,
    });

    return { found: data.total, notes };
  } catch (err) {
    ctx.audit.log({
      action: "crm.searchNotes",
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot note search failed: ${errMsg(err)}` };
  }
}

async function updateNote(
  ctx: ToolContext,
  apiKey: string,
  params: {
    noteId: string | null;
    body: string | null;
  },
) {
  if (!params.noteId) {
    return { error: "noteId is required for action 'update'." };
  }
  if (!params.body) {
    return { error: "body is required for action 'update'." };
  }

  try {
    const res = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/notes/${params.noteId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          properties: {
            // HubSpot renders note body as HTML. Auto-convert plain-text
            // newlines to <br> so LLM-emitted bodies stay readable.
            hs_note_body: ensureHtmlBody(params.body),
          },
        }),
      },
    );

    if (!res.ok) {
      const respBody = await res.text();
      return { error: `Note update failed (${res.status}): ${respBody.slice(0, 200)}` };
    }

    const note = (await res.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    ctx.audit.log({
      action: "crm.updateNote",
      details: { noteId: note.id, body: auditPreview(params.body) },
      success: true,
    });

    return {
      success: true,
      note: { id: note.id, lastModified: note.properties.hs_lastmodifieddate ?? null },
      message: "Note updated successfully.",
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.updateNote",
      details: { noteId: params.noteId, body: auditPreview(params.body!) },
      success: false,
      error: errMsg(err),
    });
    return { error: `Note update failed: ${errMsg(err)}` };
  }
}

type AssociationResult = { contactIds: string[]; dealIds: string[]; companyIds: string[] };

/** Batch-fetch associations for all notes in 3 HTTP calls (one per object type). */
async function fetchBatchAssociations(
  apiKey: string,
  noteIds: string[],
): Promise<Map<string, AssociationResult>> {
  const map = new Map<string, AssociationResult>();
  if (noteIds.length === 0) return map;

  // Initialize empty results for all notes
  for (const id of noteIds) {
    map.set(id, { contactIds: [], dealIds: [], companyIds: [] });
  }

  const types = [
    { key: "contactIds" as const, toObjectType: "contacts" },
    { key: "dealIds" as const, toObjectType: "deals" },
    { key: "companyIds" as const, toObjectType: "companies" },
  ];

  await Promise.all(
    types.map(async ({ key, toObjectType }) => {
      try {
        const res = await hubspotFetch(
          `https://api.hubapi.com/crm/v4/associations/notes/${toObjectType}/batch/read`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ inputs: noteIds.map((id) => ({ id })) }),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as {
            results: Array<{ from: { id: string }; to: Array<{ toObjectId: string }> }>;
          };
          for (const entry of body.results) {
            const existing = map.get(entry.from.id);
            if (existing) {
              existing[key] = entry.to.map((r) => r.toObjectId);
            }
          }
        } else {
          console.warn(`[hubspot] Association read for ${toObjectType} returned ${res.status}`);
        }
      } catch (err) {
        console.warn(`[hubspot] Association read for ${toObjectType} failed:`, err);
      }
    }),
  );

  return map;
}
