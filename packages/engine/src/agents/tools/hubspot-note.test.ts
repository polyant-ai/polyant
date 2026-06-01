// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import "./hubspot-note.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

function createMockResponse(
  body: string,
  opts?: { status?: number; headers?: Record<string, string> },
) {
  const headers = new Headers(opts?.headers ?? { "content-type": "application/json" });
  return {
    ok: (opts?.status ?? 200) < 400,
    status: opts?.status ?? 200,
    statusText: opts?.status && opts.status >= 400 ? "Error" : "OK",
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue(JSON.parse(body)),
    headers,
  } as unknown as Response;
}

const ctxWithKey = {
  instanceId: "test",
  secrets: { hubspot_api_key: "test-api-key" },
  audit: createMockAudit(),
} as any;

const toolCtx = { toolCallId: "tc-1", messages: [] } as any;

describe("hubspotNote", () => {
  const def = getToolRegistry().get("hubspotNote")!;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("is registered with correct metadata", () => {
    expect(def).toBeDefined();
    expect(def.name).toBe("hubspotNote");
    expect(def.category).toBe("crm");
    expect(def.requiredSecrets).toEqual(["hubspot_api_key"]);
  });

  it("has parameters and description", () => {
    const tool = buildTool(def, ctxWithKey) as any;
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  describe("create", () => {
    it("creates a note and associates to contact", async () => {
      const tool = buildTool(def, ctxWithKey) as any;

      mockFetch
        // POST /objects/notes → created
        .mockResolvedValueOnce(
          createMockResponse(JSON.stringify({ id: "n-1", properties: {} })),
        )
        // POST associations/notes/contacts/batch/create
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({})))
        // GET portal id
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ portalId: 11111111 })));

      const res = await tool.execute(
        {
          action: "create",
          body: "[CONTACT_PROFILE]\nPreferences: vegano",
          contactId: "758355632345",
          phone: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          noteId: null,
          query: null,
          createdAfter: null,
          createdBefore: null,
          limit: null,
        },
        toolCtx,
      );

      expect(res.success).toBe(true);
      expect(res.note.id).toBe("n-1");
      // First call: create note
      const firstCall = mockFetch.mock.calls[0];
      expect(firstCall[0]).toBe("https://api.hubapi.com/crm/v3/objects/notes");
      // Second call: associate to contact
      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[0]).toContain("associations/notes/contacts/batch/create");
    });

    it("returns error when body is missing", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      const res = await tool.execute(
        {
          action: "create",
          body: null,
          contactId: "1",
          dealId: null,
          companyId: null,
          ticketId: null,
          noteId: null,
          query: null,
          createdAfter: null,
          createdBefore: null,
          limit: null,
        },
        toolCtx,
      );
      expect(res.error).toMatch(/body is required/i);
    });
  });

  describe("update", () => {
    it("patches note body via PATCH /objects/notes/:id", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            id: "n-42",
            properties: { hs_lastmodifieddate: "2026-04-20T10:00:00.000Z" },
          }),
        ),
      );

      const res = await tool.execute(
        {
          action: "update",
          noteId: "n-42",
          body: "[CONTACT_PROFILE]\nPreferences: vegano",
          contactId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          query: null,
          createdAfter: null,
          createdBefore: null,
          limit: null,
        },
        toolCtx,
      );

      expect(res.success).toBe(true);
      expect(res.note.id).toBe("n-42");
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe("https://api.hubapi.com/crm/v3/objects/notes/n-42");
      expect(call[1].method).toBe("PATCH");
      expect(JSON.parse(call[1].body).properties.hs_note_body).toContain("vegano");
    });

    it("returns error when noteId is missing", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      const res = await tool.execute(
        {
          action: "update",
          noteId: null,
          body: "new body",
          contactId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          query: null,
          createdAfter: null,
          createdBefore: null,
          limit: null,
        },
        toolCtx,
      );
      expect(res.error).toMatch(/noteId is required/i);
    });

    it("returns error when body is missing", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      const res = await tool.execute(
        {
          action: "update",
          noteId: "n-42",
          body: null,
          contactId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          query: null,
          createdAfter: null,
          createdBefore: null,
          limit: null,
        },
        toolCtx,
      );
      expect(res.error).toMatch(/body is required/i);
    });
  });

  describe("search scoped by contactId", () => {
    it("fetches notes via contact associations, batch-reads bodies, and filters by query", async () => {
      const tool = buildTool(def, ctxWithKey) as any;

      mockFetch
        // GET /contacts/:id/associations/notes
        .mockResolvedValueOnce(
          createMockResponse(
            JSON.stringify({
              results: [{ toObjectId: "n-1" }, { toObjectId: "n-2" }, { toObjectId: "n-3" }],
            }),
          ),
        )
        // POST /notes/batch/read
        .mockResolvedValueOnce(
          createMockResponse(
            JSON.stringify({
              results: [
                {
                  id: "n-1",
                  properties: {
                    hs_note_body: "[CONTACT_PROFILE]\nPreferences: vegano",
                    hs_timestamp: "2026-04-20T10:00:00.000Z",
                    hs_lastmodifieddate: "2026-04-20T10:00:00.000Z",
                    hubspot_owner_id: null,
                  },
                },
                {
                  id: "n-2",
                  properties: {
                    hs_note_body: "Random unrelated note",
                    hs_timestamp: "2026-04-19T10:00:00.000Z",
                    hs_lastmodifieddate: "2026-04-19T10:00:00.000Z",
                    hubspot_owner_id: null,
                  },
                },
                {
                  id: "n-3",
                  properties: {
                    hs_note_body: "[CONTACT_PROFILE] older",
                    hs_timestamp: "2026-04-18T10:00:00.000Z",
                    hs_lastmodifieddate: "2026-04-18T10:00:00.000Z",
                    hubspot_owner_id: null,
                  },
                },
              ],
            }),
          ),
        )
        // 3 batch association reads (contacts/deals/companies)
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        // GET portal id
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ portalId: 11111111 })));

      const res = await tool.execute(
        {
          action: "search",
          contactId: "758355632345",
          query: "[CONTACT_PROFILE]",
          limit: 5,
          body: null,
          noteId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          createdAfter: null,
          createdBefore: null,
        },
        toolCtx,
      );

      expect(res.found).toBe(2);
      expect(res.notes).toHaveLength(2);
      // Sorted by timestamp desc → n-1 first (2026-04-20) then n-3 (2026-04-18)
      expect(res.notes[0].id).toBe("n-1");
      expect(res.notes[1].id).toBe("n-3");
      // First call should be the contact associations endpoint
      expect(mockFetch.mock.calls[0][0]).toContain(
        "/crm/v4/objects/contacts/758355632345/associations/notes",
      );
      // Second call is batch read
      expect(mockFetch.mock.calls[1][0]).toBe("https://api.hubapi.com/crm/v3/objects/notes/batch/read");
    });

    it("returns found=0 when contact has no associated notes", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockFetch.mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ results: [] })),
      );

      const res = await tool.execute(
        {
          action: "search",
          contactId: "999",
          query: null,
          limit: null,
          body: null,
          noteId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          createdAfter: null,
          createdBefore: null,
        },
        toolCtx,
      );

      expect(res.found).toBe(0);
      expect(res.notes).toEqual([]);
      // Only one fetch call — associations list — short-circuit on empty
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("falls back to global search when contactId is not provided", async () => {
      const tool = buildTool(def, ctxWithKey) as any;

      mockFetch
        // POST /notes/search (global)
        .mockResolvedValueOnce(
          createMockResponse(
            JSON.stringify({
              total: 1,
              results: [
                {
                  id: "n-42",
                  properties: {
                    hs_note_body: "some note",
                    hs_timestamp: "2026-04-20T10:00:00.000Z",
                    hs_lastmodifieddate: "2026-04-20T10:00:00.000Z",
                    hubspot_owner_id: null,
                  },
                },
              ],
            }),
          ),
        )
        // 3 batch association reads
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        // portal id
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ portalId: 11111111 })));

      const res = await tool.execute(
        {
          action: "search",
          contactId: null,
          query: "some",
          limit: null,
          body: null,
          noteId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          createdAfter: null,
          createdBefore: null,
        },
        toolCtx,
      );

      expect(res.found).toBe(1);
      expect(mockFetch.mock.calls[0][0]).toBe("https://api.hubapi.com/crm/v3/objects/notes/search");
    });
  });

  describe("phone → contactId auto-resolution", () => {
    it("search with phone (no contactId) resolves first, then searches notes of that contact", async () => {
      const tool = buildTool(def, ctxWithKey) as any;

      mockFetch
        // 1. Phone lookup → returns contactId c-42
        .mockResolvedValueOnce(
          createMockResponse(JSON.stringify({ results: [{ id: "c-42" }] })),
        )
        // 2. Contact→notes associations list
        .mockResolvedValueOnce(
          createMockResponse(JSON.stringify({ results: [{ toObjectId: "n-1" }] })),
        )
        // 3. Batch read notes
        .mockResolvedValueOnce(
          createMockResponse(
            JSON.stringify({
              results: [
                {
                  id: "n-1",
                  properties: {
                    hs_note_body: "[CONTACT_PROFILE] body",
                    hs_timestamp: "2026-04-21T10:00:00.000Z",
                    hs_lastmodifieddate: "2026-04-21T10:00:00.000Z",
                    hubspot_owner_id: null,
                  },
                },
              ],
            }),
          ),
        )
        // 4-6. Batch association reads (contacts/deals/companies)
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })))
        // 7. Portal id
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ portalId: 11111111 })));

      const res = await tool.execute(
        {
          action: "search",
          contactId: null,
          phone: "+390000000001",
          query: "[CONTACT_PROFILE]",
          limit: 5,
          body: null,
          noteId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          createdAfter: null,
          createdBefore: null,
        },
        toolCtx,
      );

      expect(res.found).toBe(1);
      // First call MUST be the contact search (phone resolution), not the associations list
      expect(mockFetch.mock.calls[0][0]).toBe("https://api.hubapi.com/crm/v3/objects/contacts/search");
      const body0 = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Emits 4 EQ filterGroups (with+/no-+ × phone/mobilephone) + 1 CONTAINS_TOKEN fallback
      expect(body0.filterGroups).toHaveLength(5);
      // Second call: contact → notes associations for resolved c-42
      expect(mockFetch.mock.calls[1][0]).toContain("/crm/v4/objects/contacts/c-42/associations/notes");
    });

    it("create with phone (no contactId) resolves phone → associates note to that contact", async () => {
      const tool = buildTool(def, ctxWithKey) as any;

      mockFetch
        // 1. Phone lookup
        .mockResolvedValueOnce(
          createMockResponse(JSON.stringify({ results: [{ id: "c-42" }] })),
        )
        // 2. Create note
        .mockResolvedValueOnce(
          createMockResponse(JSON.stringify({ id: "n-new", properties: {} })),
        )
        // 3. Associate to contact
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({})))
        // 4. Portal id
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({ portalId: 11111111 })));

      const res = await tool.execute(
        {
          action: "create",
          body: "<p>profile</p>",
          contactId: null,
          phone: "+390000000001",
          dealId: null,
          companyId: null,
          ticketId: null,
          noteId: null,
          query: null,
          createdAfter: null,
          createdBefore: null,
          limit: null,
        },
        toolCtx,
      );

      expect(res.success).toBe(true);
      // First call: phone resolution
      expect(mockFetch.mock.calls[0][0]).toBe("https://api.hubapi.com/crm/v3/objects/contacts/search");
      // Second call: create note
      expect(mockFetch.mock.calls[1][0]).toBe("https://api.hubapi.com/crm/v3/objects/notes");
      // Third call: associate note→contact, to resolved id c-42
      expect(mockFetch.mock.calls[2][0]).toContain("associations/notes/contacts/batch/create");
      const body2 = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(body2.inputs[0].to.id).toBe("c-42");
    });

    it("returns error if phone does not match any contact (no contactId fallback)", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockFetch.mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ results: [] })),
      );

      const res = await tool.execute(
        {
          action: "search",
          contactId: null,
          phone: "+393990000000",
          query: null,
          limit: null,
          body: null,
          noteId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          createdAfter: null,
          createdBefore: null,
        },
        toolCtx,
      );

      expect(res.error).toMatch(/No contact found/i);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("contactId takes precedence over phone (no extra resolution call)", async () => {
      const tool = buildTool(def, ctxWithKey) as any;

      mockFetch
        // Associations list (direct, no phone resolution needed)
        .mockResolvedValueOnce(
          createMockResponse(JSON.stringify({ results: [] })),
        );

      const res = await tool.execute(
        {
          action: "search",
          contactId: "c-explicit",
          phone: "+390000000001",
          query: null,
          limit: null,
          body: null,
          noteId: null,
          dealId: null,
          companyId: null,
          ticketId: null,
          createdAfter: null,
          createdBefore: null,
        },
        toolCtx,
      );

      expect(res.found).toBe(0);
      // Single call: the associations list for c-explicit — no contact search for phone
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain("/contacts/c-explicit/associations/notes");
    });

    it("update ignores phone (noteId is enough)", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            id: "n-42",
            properties: { hs_lastmodifieddate: "2026-04-21T10:00:00.000Z" },
          }),
        ),
      );

      const res = await tool.execute(
        {
          action: "update",
          noteId: "n-42",
          body: "<p>updated</p>",
          contactId: null,
          phone: "+390000000001",
          dealId: null,
          companyId: null,
          ticketId: null,
          query: null,
          createdAfter: null,
          createdBefore: null,
          limit: null,
        },
        toolCtx,
      );

      expect(res.success).toBe(true);
      // Single call: PATCH on note — no phone resolution
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain("/crm/v3/objects/notes/n-42");
    });
  });
});
