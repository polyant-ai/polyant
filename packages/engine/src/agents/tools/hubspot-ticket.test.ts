// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import hubspotTicketTool from "./hubspot-ticket.tool.js";
import { buildTool } from "./registry.js";
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

const ctxWithoutKey = {
  instanceId: "test",
  secrets: {},
  audit: createMockAudit(),
} as any;

const toolCtx = { toolCallId: "tc-1", messages: [] } as any;

const baseParams = {
  action: "update" as const,
  subject: null,
  content: null,
  contactId: null,
  pipelineStage: null,
  ticketId: null,
  query: null,
  priority: null,
  createdAfter: null,
  createdBefore: null,
  openOnly: null,
  limit: null,
};

describe("hubspotTicket", () => {
  const def = hubspotTicketTool;

  beforeEach(() => {
    // mockReset clears both call history and the queued mockResolvedValueOnce entries
    mockFetch.mockReset();
  });

  it("is registered with correct metadata and supports update action", async () => {
    expect(def).toBeDefined();
    expect(def.name).toBe("hubspotTicket");
    expect(def.category).toBe("crm");
    expect(def.requiredSecrets).toEqual([{ key: "hubspot_api_key", type: "text", sensitive: true }]);
    // Indirect check that the action enum accepts "update": invoking execute with
    // action="update" should reach the update branch (which fails on missing ticketId).
    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute(
      { ...baseParams, action: "update" },
      toolCtx,
    );
    expect(result.error).toContain("ticketId is required");
  });

  describe("action: update", () => {
    it("returns error when ticketId is missing", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      const result = await tool.execute(
        { ...baseParams, action: "update", priority: "HIGH" },
        toolCtx,
      );
      expect(result.error).toContain("ticketId is required");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns error when no updatable field is provided", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      const result = await tool.execute(
        { ...baseParams, action: "update", ticketId: "t-1" },
        toolCtx,
      );
      expect(result.error).toContain("at least one of priority");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns error when API key is missing", async () => {
      const tool = buildTool(def, ctxWithoutKey) as any;
      const result = await tool.execute(
        { ...baseParams, action: "update", ticketId: "t-1", priority: "HIGH" },
        toolCtx,
      );
      expect(result.error).toMatch(/HubSpot API key/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("PATCHes only priority when only priority is provided, logs diff in audit", async () => {
      const tool = buildTool(def, ctxWithKey) as any;

      // 1. snapshot before (GET previous properties)
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            id: "t-42",
            properties: { hs_ticket_priority: "MEDIUM", hs_pipeline_stage: "2" },
          }),
        ),
      );
      // 2. PATCH update
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            id: "t-42",
            properties: { hs_ticket_priority: "HIGH", hs_pipeline_stage: "2" },
          }),
        ),
      );
      // 3. portal id
      mockFetch.mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 12345678 })),
      );

      const result = await tool.execute(
        { ...baseParams, action: "update", ticketId: "t-42", priority: "HIGH" },
        toolCtx,
      );

      expect(result.success).toBe(true);
      expect(result.ticket.id).toBe("t-42");
      expect(result.ticket.priority).toBe("HIGH");
      expect(result.previous.priority).toBe("MEDIUM");

      // Verify PATCH call
      const patchCall = mockFetch.mock.calls.find(
        (call) => call[1]?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toBe("https://api.hubapi.com/crm/v3/objects/tickets/t-42");
      const body = JSON.parse(patchCall![1].body);
      expect(body.properties.hs_ticket_priority).toBe("HIGH");
      expect(body.properties.content).toBeUndefined();
      expect(body.properties.hs_pipeline_stage).toBeUndefined();
    });

    it("PATCHes multiple fields when content, priority and pipelineStage are all provided", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse(
            JSON.stringify({
              id: "t-9",
              properties: { hs_ticket_priority: "LOW", hs_pipeline_stage: "1" },
            }),
          ),
        )
        .mockResolvedValueOnce(
          createMockResponse(
            JSON.stringify({
              id: "t-9",
              properties: { hs_ticket_priority: "HIGH", hs_pipeline_stage: "3" },
            }),
          ),
        )
        .mockResolvedValueOnce(
          createMockResponse(JSON.stringify({ portalId: 12345678 })),
        );

      const result = await tool.execute(
        {
          ...baseParams,
          action: "update",
          ticketId: "t-9",
          priority: "HIGH",
          content: "Aggiornamento contesto via chat",
          pipelineStage: "3",
        },
        toolCtx,
      );

      expect(result.success).toBe(true);
      const patchCall = mockFetch.mock.calls.find(
        (call) => call[1]?.method === "PATCH",
      );
      const body = JSON.parse(patchCall![1].body);
      expect(body.properties.hs_ticket_priority).toBe("HIGH");
      expect(body.properties.content).toBe("Aggiornamento contesto via chat");
      expect(body.properties.hs_pipeline_stage).toBe("3");
    });

    it("returns error on HTTP failure", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockFetch
        // before snapshot ok
        .mockResolvedValueOnce(
          createMockResponse(
            JSON.stringify({ id: "t-1", properties: { hs_ticket_priority: "MEDIUM" } }),
          ),
        )
        // PATCH fails
        .mockResolvedValueOnce(
          createMockResponse('{"message": "Not found"}', { status: 404 }),
        );

      const result = await tool.execute(
        { ...baseParams, action: "update", ticketId: "t-1", priority: "HIGH" },
        toolCtx,
      );

      expect(result.error).toContain("Ticket update failed (404)");
    });

    it("succeeds even if the before-snapshot fetch fails (best-effort diff)", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      // snapshot before: network error
      mockFetch.mockRejectedValueOnce(new Error("transient"));
      // PATCH ok
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            id: "t-1",
            properties: { hs_ticket_priority: "HIGH" },
          }),
        ),
      );
      // portal id
      mockFetch.mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 12345678 })),
      );

      const result = await tool.execute(
        { ...baseParams, action: "update", ticketId: "t-1", priority: "HIGH" },
        toolCtx,
      );

      expect(result.success).toBe(true);
      expect(result.previous.priority).toBeNull();
    });

    it("handles network errors gracefully", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      // snapshot before returns ok
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({ id: "t-1", properties: { hs_ticket_priority: "MEDIUM" } }),
        ),
      );
      // PATCH throws
      mockFetch.mockRejectedValueOnce(new Error("network down"));

      const result = await tool.execute(
        { ...baseParams, action: "update", ticketId: "t-1", priority: "HIGH" },
        toolCtx,
      );

      expect(result.error).toContain("Ticket update failed");
      expect(result.error).toContain("network down");
    });
  });

  describe("action: search filters", () => {
    function mockSearchSuccess(total = 0, tickets: any[] = []) {
      // Route-based mock: independent of call ordering and of the portalId
      // in-memory cache (which is shared across tests and may already be hot).
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/tickets/search")) {
          return createMockResponse(JSON.stringify({ total, results: tickets }));
        }
        if (url.includes("/account-info/v3/details")) {
          return createMockResponse(JSON.stringify({ portalId: 12345678 }));
        }
        if (url.includes("/associations/tickets/companies/batch/read")) {
          return createMockResponse(JSON.stringify({ results: [] }));
        }
        if (url.includes("/companies/batch/read")) {
          return createMockResponse(JSON.stringify({ results: [] }));
        }
        throw new Error(`Unexpected URL in mock: ${url}`);
      });
    }

    it("forwards contactId as associations.contact filter", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockSearchSuccess();

      await tool.execute(
        { ...baseParams, action: "search", contactId: "c-77" },
        toolCtx,
      );

      const [searchUrl, searchOpts] = mockFetch.mock.calls[0];
      expect(searchUrl).toBe("https://api.hubapi.com/crm/v3/objects/tickets/search");
      const body = JSON.parse(searchOpts.body);
      const filters = body.filterGroups[0].filters;
      expect(filters).toContainEqual({
        propertyName: "associations.contact",
        operator: "EQ",
        value: "c-77",
      });
    });

    it("forwards openOnly as hs_pipeline_stage NEQ 4 filter", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockSearchSuccess();

      await tool.execute(
        { ...baseParams, action: "search", openOnly: true },
        toolCtx,
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const filters = body.filterGroups[0].filters;
      expect(filters).toContainEqual({
        propertyName: "hs_pipeline_stage",
        operator: "NEQ",
        value: "4",
      });
    });

    it("combines contactId + openOnly + priority + date filters", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockSearchSuccess();

      await tool.execute(
        {
          ...baseParams,
          action: "search",
          contactId: "c-1",
          openOnly: true,
          priority: "HIGH",
          createdAfter: "2026-05-01",
        },
        toolCtx,
      );

      const filters = JSON.parse(mockFetch.mock.calls[0][1].body).filterGroups[0].filters;
      expect(filters).toEqual(
        expect.arrayContaining([
          { propertyName: "hs_ticket_priority", operator: "EQ", value: "HIGH" },
          { propertyName: "createdate", operator: "GTE", value: "2026-05-01" },
          { propertyName: "associations.contact", operator: "EQ", value: "c-1" },
          { propertyName: "hs_pipeline_stage", operator: "NEQ", value: "4" },
        ]),
      );
    });

    it("does not add new filters when contactId/openOnly are null (regression: classic search still works)", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockSearchSuccess();

      await tool.execute(
        { ...baseParams, action: "search", priority: "HIGH" },
        toolCtx,
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const filters = body.filterGroups[0].filters;
      expect(filters).toEqual([
        { propertyName: "hs_ticket_priority", operator: "EQ", value: "HIGH" },
      ]);
    });

    it("returns pipeline and stage in the result rows", async () => {
      const tool = buildTool(def, ctxWithKey) as any;
      mockSearchSuccess(1, [
        {
          id: "t-1",
          properties: {
            subject: "Test",
            content: "x",
            hs_ticket_priority: "MEDIUM",
            hs_pipeline: "0",
            hs_pipeline_stage: "2",
            createdate: "2026-05-01T00:00:00Z",
            hs_lastmodifieddate: "2026-05-01T00:00:00Z",
            hs_ticket_category: null,
          },
        },
      ]);

      const result = await tool.execute(
        { ...baseParams, action: "search", openOnly: true },
        toolCtx,
      );

      expect(result.found).toBe(1);
      expect(result.tickets[0].pipeline).toBe("0");
      expect(result.tickets[0].stage).toBe("2");
    });
  });
});
