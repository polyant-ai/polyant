// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import "./hubspot-create-task.tool.js";
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

const ctxWithoutKey = {
  instanceId: "test",
  secrets: {},
  audit: createMockAudit(),
} as any;

const toolCtx = { toolCallId: "tc-1", messages: [] } as any;

describe("hubspotCreateTask", () => {
  const def = getToolRegistry().get("hubspotCreateTask")!;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is registered with correct metadata", () => {
    expect(def).toBeDefined();
    expect(def.name).toBe("hubspotCreateTask");
    expect(def.category).toBe("crm");
    expect(def.requiredSecrets).toEqual(["hubspot_api_key"]);
  });

  it("has parameters and description", () => {
    const tool = buildTool(def, ctxWithKey) as any;
    expect(tool.description).toBeDefined();
    expect(tool.inputSchema).toBeDefined();
  });

  it("returns error when API key is missing", async () => {
    const tool = buildTool(def, ctxWithoutKey) as any;
    const result = await tool.execute(
      { contactId: "123", subject: "Test", body: null, priority: "MEDIUM", dueDate: null },
      toolCtx,
    );
    expect(result).toEqual({ error: "HubSpot API key not configured. Set the key in the instance settings." });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("creates task and associates with contact on success", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    // Mock task creation response
    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ id: "task-456", properties: {} })),
      )
      // Mock association response
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ results: [] })),
      )
      // Mock portal ID response (getHubSpotPortalId)
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 12345678 })),
      );

    const result = await tool.execute(
      {
        contactId: "contact-123",
        subject: "Richiamata paziente - Mario Rossi",
        body: "Paziente richiede informazioni su trattamento",
        priority: "HIGH",
        dueDate: null,
      },
      toolCtx,
    );

    expect(result.success).toBe(true);
    expect(result.task.id).toBe("task-456");
    expect(result.task.subject).toBe("Richiamata paziente - Mario Rossi");
    expect(result.task.priority).toBe("HIGH");

    // Verify task creation call (3 calls: create, associate, getPortalId)
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [createUrl, createOpts] = mockFetch.mock.calls[0];
    expect(createUrl).toBe("https://api.hubapi.com/crm/v3/objects/tasks");
    expect(createOpts.method).toBe("POST");
    expect(createOpts.headers.Authorization).toBe("Bearer test-api-key");

    const createBody = JSON.parse(createOpts.body);
    expect(createBody.properties.hs_task_subject).toBe("Richiamata paziente - Mario Rossi");
    expect(createBody.properties.hs_task_body).toBe("Paziente richiede informazioni su trattamento");
    expect(createBody.properties.hs_task_priority).toBe("HIGH");
    expect(createBody.properties.hs_task_status).toBe("NOT_STARTED");
    expect(createBody.properties.hs_task_type).toBe("CALL");

    // Verify association call
    const [assocUrl, assocOpts] = mockFetch.mock.calls[1];
    expect(assocUrl).toBe("https://api.hubapi.com/crm/v3/associations/tasks/contacts/batch/create");
    const assocBody = JSON.parse(assocOpts.body);
    expect(assocBody.inputs[0].from.id).toBe("task-456");
    expect(assocBody.inputs[0].to.id).toBe("contact-123");
    expect(assocBody.inputs[0].type).toBe("204");
  });

  it("uses provided dueDate when given", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(createMockResponse(JSON.stringify({ id: "task-789", properties: {} })))
      .mockResolvedValueOnce(createMockResponse(JSON.stringify({ results: [] })));

    const result = await tool.execute(
      {
        contactId: "c-1",
        subject: "Test",
        body: null,
        priority: "LOW",
        dueDate: "2026-04-15T09:00:00",
      },
      toolCtx,
    );

    expect(result.success).toBe(true);
    const createBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(createBody.properties.hs_timestamp).toBe(new Date("2026-04-15T09:00:00").toISOString());
    // body should not be set when null
    expect(createBody.properties.hs_task_body).toBeUndefined();
  });

  it("returns error for invalid dueDate", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    const result = await tool.execute(
      { contactId: "c-1", subject: "Test", body: null, priority: "MEDIUM", dueDate: "not-a-date" },
      toolCtx,
    );

    expect(result.error).toContain("Invalid date format");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns partial success when association fails", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(createMockResponse(JSON.stringify({ id: "task-999", properties: {} })))
      .mockResolvedValueOnce(
        createMockResponse('{"message": "Association error"}', { status: 400 }),
      );

    const result = await tool.execute(
      { contactId: "c-1", subject: "Test", body: null, priority: "MEDIUM", dueDate: null },
      toolCtx,
    );

    expect(result.success).toBe(true);
    expect(result.warning).toContain("association to the contact failed");
    expect(result.task.id).toBe("task-999");
  });

  it("returns error when task creation fails", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch.mockResolvedValueOnce(
      createMockResponse('{"message": "Unauthorized"}', { status: 401 }),
    );

    const result = await tool.execute(
      { contactId: "c-1", subject: "Test", body: null, priority: "MEDIUM", dueDate: null },
      toolCtx,
    );

    expect(result.error).toContain("Task creation failed (401)");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles network errors gracefully", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    const result = await tool.execute(
      { contactId: "c-1", subject: "Test", body: null, priority: "MEDIUM", dueDate: null },
      toolCtx,
    );

    expect(result.error).toContain("Task creation failed");
    expect(result.error).toContain("Network failure");
  });
});
