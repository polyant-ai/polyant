// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock fetch globally before any imports
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// renderFetch tests
// ---------------------------------------------------------------------------
import { renderFetch } from "./render-fetch.js";

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers(headers),
  } as unknown as Response;
}

interface RenderLogsResponseFixture {
  hasMore: boolean;
  logs: Array<{ id: string; labels: Array<{ name: string; value: string }>; message: string; timestamp: string }>;
  nextStartTime?: string;
  nextEndTime?: string;
}

describe("renderFetch", () => {
  const API_KEY = "rnd_test_key_123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends GET with Bearer auth and returns parsed JSON", async () => {
    const payload = [{ cursor: "c1", service: { id: "srv-1" } }];
    mockFetch.mockResolvedValue(mockResponse(payload));

    const result = await renderFetch<typeof payload>("/services", {}, API_KEY);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.render.com/v1/services",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer rnd_test_key_123",
          Accept: "application/json",
        }),
      }),
    );
    expect(result).toEqual(payload);
  });

  it("appends scalar query params to URL", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));

    await renderFetch("/services", { name: "my-app", limit: "10" }, API_KEY);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("name=my-app");
    expect(calledUrl).toContain("limit=10");
  });

  it("handles array params by repeating the key (Render convention)", async () => {
    mockFetch.mockResolvedValue(mockResponse({ logs: [] }));

    await renderFetch("/logs", { resource: ["srv-a", "srv-b"], level: ["error", "warning"] }, API_KEY);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    // Render uses repeated keys: resource=srv-a&resource=srv-b
    expect(calledUrl).toContain("resource=srv-a");
    expect(calledUrl).toContain("resource=srv-b");
    expect(calledUrl).toContain("level=error");
    expect(calledUrl).toContain("level=warning");
  });

  it("retries on 429 with exponential backoff", async () => {
    const retryResponse = mockResponse({ message: "rate limited" }, 429, { "Retry-After": "1" });
    const okResponse = mockResponse({ ok: true });

    mockFetch
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce(okResponse);

    const result = await renderFetch<{ ok: boolean }>("/services", {}, API_KEY);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true });
  });

  it("throws after exhausting retries on persistent 429", async () => {
    const retryResponse = mockResponse({ message: "rate limited" }, 429);
    mockFetch.mockResolvedValue(retryResponse);

    await expect(renderFetch("/services", {}, API_KEY)).rejects.toThrow(
      "Render API rate limit: exhausted 3 retries",
    );
    expect(mockFetch).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("throws on non-OK response (not 429)", async () => {
    mockFetch.mockResolvedValue(mockResponse({ message: "Unauthorized" }, 401));

    await expect(renderFetch("/services", {}, API_KEY)).rejects.toThrow(
      "Render API error (401)",
    );
  });

  it("sanitizes control characters from response body before parsing", async () => {
    // Render log messages can contain control chars (e.g. \x00, \x1b) that break JSON.parse
    const jsonWithControlChars = '{"logs":[{"message":"line1\\u0000line2"}],"hasMore":false}';
    type SanitizedResult = { logs: { message: string }[]; hasMore: boolean };

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      // text() returns raw string with control char; json() would fail
      text: vi.fn().mockResolvedValue(jsonWithControlChars.replace("\\u0000", "\x00")),
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
      headers: new Headers(),
    } as unknown as Response);

    const result = await renderFetch<SanitizedResult>("/logs", {}, API_KEY);
    expect(result.logs[0].message).toBe("line1line2");
  });
});

// ---------------------------------------------------------------------------
// Mock pipeline logger
// ---------------------------------------------------------------------------
vi.mock("@/utils/pipeline-logger.js", () => ({
  pipelineLog: { toolCall: vi.fn(), toolResult: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Tool tests — uses real Render API response shapes
// ---------------------------------------------------------------------------
import "./render-service.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

const toolCtx = { toolCallId: "tc-1", messages: [] } as any;

function buildRenderServiceTool(secretOverrides?: Record<string, string>) {
  const def = getToolRegistry().get("renderService")!;
  expect(def).toBeDefined();
  return buildTool(def, {
    agentId: "test",
    secrets: { render_api_key: "rnd_test_key", ...secretOverrides },
    audit: createMockAudit(),
  } as any) as any;
}

describe("renderService tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("is registered with correct metadata", () => {
      const def = getToolRegistry().get("renderService")!;
      expect(def).toBeDefined();
      expect(def.category).toBe("devops");
      expect(def.requiredSecrets).toEqual(["render_api_key"]);
    });
  });

  describe("action: list", () => {
    it("returns services mapped from Render API shape", async () => {
      // Real Render API shape: array of { cursor, service: {...} }
      const renderResponse = [
        {
          cursor: "c1",
          service: {
            id: "srv-abc",
            name: "web-api",
            type: "web_service",
            slug: "web-api",
            suspended: "not_suspended",
            suspenders: [],
            serviceDetails: { region: "frankfurt", plan: "starter", url: "https://web-api.onrender.com" },
            dashboardUrl: "https://dashboard.render.com/web/srv-abc",
            ownerId: "tea-123",
            updatedAt: "2026-04-15T09:44:38Z",
            createdAt: "2026-04-02T08:11:12Z",
          },
        },
        {
          cursor: "c2",
          service: {
            id: "srv-def",
            name: "worker",
            type: "web_service",
            slug: "worker",
            suspended: "suspended",
            suspenders: ["user"],
            serviceDetails: { region: "frankfurt", plan: "starter", url: "https://worker.onrender.com" },
            dashboardUrl: "https://dashboard.render.com/web/srv-def",
            ownerId: "tea-123",
            updatedAt: "2026-04-15T09:42:52Z",
            createdAt: "2026-04-02T08:11:57Z",
          },
        },
      ];
      mockFetch.mockResolvedValue(mockResponse(renderResponse));

      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "list", environmentId: null, ownerId: null, resourceIds: null, serviceId: null,
        startTime: null, endTime: null, level: null, text: null, limit: null,
      }, toolCtx);

      expect(result.services).toHaveLength(2);
      expect(result.services[0]).toMatchObject({
        id: "srv-abc",
        name: "web-api",
        type: "web_service",
        region: "frankfurt",
        status: "active",
        plan: "starter",
        url: "https://web-api.onrender.com",
        dashboardUrl: "https://dashboard.render.com/web/srv-abc",
      });
      expect(result.services[1].status).toBe("suspended");
    });

    it("returns error when API key is missing", async () => {
      const def = getToolRegistry().get("renderService")!;
      const tool = buildTool(def, {
        agentId: "test",
        secrets: {},
        audit: createMockAudit(),
      } as any) as any;

      const result = await tool.execute({
        action: "list", environmentId: null, ownerId: null, resourceIds: null, serviceId: null,
        startTime: null, endTime: null, level: null, text: null, limit: null,
      }, toolCtx);
      expect(result.error).toContain("render_api_key");
    });
  });

  describe("action: logs", () => {
    it("fetches logs and extracts level from labels array", async () => {
      const logResponse: RenderLogsResponseFixture = {
        hasMore: false,
        logs: [
          {
            id: "log-1",
            labels: [
              { name: "resource", value: "srv-abc" },
              { name: "instance", value: "srv-abc-xr5bj" },
              { name: "level", value: "error" },
              { name: "type", value: "app" },
            ],
            message: "Telegram polling error: GrammyError",
            timestamp: "2026-04-14T14:32:00Z",
          },
          {
            id: "log-2",
            labels: [
              { name: "resource", value: "srv-abc" },
              { name: "level", value: "warning" },
              { name: "type", value: "app" },
            ],
            message: "A pong wasn't received from the server",
            timestamp: "2026-04-14T15:10:00Z",
          },
        ],
      };
      mockFetch.mockResolvedValue(mockResponse(logResponse));

      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "logs", ownerId: "own-123", resourceIds: ["srv-abc"], serviceId: null,
        startTime: null, endTime: null, level: ["error", "warning"], text: null, limit: null,
      }, toolCtx);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toMatchObject({
        id: "log-1",
        level: "error",
        type: "app",
        message: "Telegram polling error: GrammyError",
      });
      expect(result.entries[1].level).toBe("warning");
      expect(result.truncated).toBe(false);
    });

    it("handles response with missing logs field", async () => {
      // Render API may return { hasMore: false } without a logs array
      mockFetch.mockResolvedValue(mockResponse({ hasMore: false }));

      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "logs", ownerId: "own-123", resourceIds: ["srv-abc"], serviceId: null,
        startTime: null, endTime: null, level: ["error"], text: null, limit: null,
      }, toolCtx);

      expect(result.entries).toHaveLength(0);
      expect(result.truncated).toBe(false);
    });

    it("requires ownerId for logs action", async () => {
      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "logs", ownerId: null, resourceIds: ["srv-abc"], serviceId: null,
        startTime: null, endTime: null, level: null, text: null, limit: null,
      }, toolCtx);
      expect(result.error).toContain("ownerId");
    });

    it("requires resourceIds for logs action", async () => {
      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "logs", ownerId: "own-123", resourceIds: null, serviceId: null,
        startTime: null, endTime: null, level: null, text: null, limit: null,
      }, toolCtx);
      expect(result.error).toContain("resourceIds");
    });

    it("auto-paginates when hasMore is true", async () => {
      const makeLogs = (count: number, prefix: string) =>
        Array.from({ length: count }, (_, i) => ({
          id: `${prefix}-${i}`,
          labels: [{ name: "level", value: "error" }, { name: "type", value: "app" }],
          message: `Error ${prefix}-${i}`,
          timestamp: "2026-04-14T10:00:00Z",
        }));

      // Page 1: 100 entries + hasMore
      mockFetch
        .mockResolvedValueOnce(mockResponse({
          hasMore: true,
          logs: makeLogs(100, "p1"),
          nextStartTime: "2026-04-14T02:00:00Z",
          nextEndTime: "2026-04-15T00:00:00Z",
        }))
        // Page 2: 50 entries, done
        .mockResolvedValueOnce(mockResponse({
          hasMore: false,
          logs: makeLogs(50, "p2"),
        }));

      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "logs", ownerId: "own-123", resourceIds: ["srv-abc"], serviceId: null,
        startTime: null, endTime: null, level: ["error"], text: null, limit: null,
      }, toolCtx);

      expect(result.entries).toHaveLength(150);
      expect(result.truncated).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns partial results when a page fails mid-pagination", async () => {
      const page1: RenderLogsResponseFixture = {
        hasMore: true,
        logs: Array.from({ length: 100 }, (_, i) => ({
          id: `log-${i}`,
          labels: [{ name: "level", value: "error" }, { name: "type", value: "app" }],
          message: `Error ${i}`,
          timestamp: "2026-04-14T10:00:00Z",
        })),
        nextStartTime: "2026-04-14T02:00:00Z",
        nextEndTime: "2026-04-15T00:00:00Z",
      };

      mockFetch
        .mockResolvedValueOnce(mockResponse(page1))
        .mockRejectedValueOnce(new SyntaxError("Unexpected token in JSON"));

      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "logs", ownerId: "own-123", resourceIds: ["srv-abc"], serviceId: null,
        startTime: null, endTime: null, level: ["error"], text: null, limit: null,
      }, toolCtx);

      expect(result.entries).toHaveLength(100);
      expect(result.truncated).toBe(true);
    });

    it("sets truncated=true when limit is reached", async () => {
      const makeLogs = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
          id: `log-${i}`,
          labels: [{ name: "level", value: "error" }],
          message: `Error ${i}`,
          timestamp: "2026-04-14T10:00:00Z",
        }));

      mockFetch.mockResolvedValue(mockResponse({
        hasMore: true,
        logs: makeLogs(100),
        nextStartTime: "t1",
        nextEndTime: "t2",
      }));

      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "logs", ownerId: "own-123", resourceIds: ["srv-abc"], serviceId: null,
        startTime: null, endTime: null, level: null, text: null, limit: 50,
      }, toolCtx);

      expect(result.entries).toHaveLength(50);
      expect(result.truncated).toBe(true);
    });
  });

  describe("action: deploys", () => {
    it("fetches recent deploys from real Render API shape", async () => {
      // Real shape: [{ cursor, deploy: {...} }]
      const deploysResponse = [
        {
          cursor: "c1",
          deploy: {
            id: "dep-1",
            status: "live",
            trigger: "new_commit",
            commit: { id: "abc123", message: "feat: add feature", createdAt: "2026-04-15T10:00:00Z" },
            createdAt: "2026-04-15T10:05:00Z",
            updatedAt: "2026-04-15T10:08:00Z",
            startedAt: "2026-04-15T10:05:00Z",
            finishedAt: "2026-04-15T10:08:00Z",
          },
        },
        {
          cursor: "c2",
          deploy: {
            id: "dep-2",
            status: "update_failed",
            trigger: "new_commit",
            commit: { id: "def456", message: "fix: broken build", createdAt: "2026-04-15T08:00:00Z" },
            createdAt: "2026-04-15T08:05:00Z",
            updatedAt: "2026-04-15T08:06:00Z",
            startedAt: "2026-04-15T08:05:00Z",
            finishedAt: "2026-04-15T08:06:00Z",
          },
        },
      ];
      mockFetch.mockResolvedValue(mockResponse(deploysResponse));

      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "deploys", ownerId: null, resourceIds: null, serviceId: "srv-abc",
        startTime: null, endTime: null, level: null, text: null, limit: null,
      }, toolCtx);

      expect(result.deploys).toHaveLength(2);
      expect(result.deploys[0]).toMatchObject({
        id: "dep-1",
        status: "live",
        trigger: "new_commit",
        commitMessage: "feat: add feature",
        commitId: "abc123",
      });
      expect(result.deploys[1].status).toBe("update_failed");
    });

    it("normalizes timezone offset timestamps to UTC", async () => {
      mockFetch.mockResolvedValue(mockResponse([]));

      const tool = buildRenderServiceTool();
      await tool.execute({
        action: "deploys", ownerId: null, resourceIds: null, serviceId: "srv-abc",
        startTime: "2026-04-14T00:00:00+02:00", endTime: "2026-04-14T23:59:59+02:00",
        level: null, text: null, limit: null,
      }, toolCtx);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      // +02:00 offset should be converted to UTC (Z suffix), not sent raw
      expect(calledUrl).toContain("createdAfter=2026-04-13T22%3A00%3A00.000Z");
      expect(calledUrl).toContain("createdBefore=2026-04-14T21%3A59%3A59.000Z");
      expect(calledUrl).not.toContain("%2B02"); // no raw +02:00 offset
    });

    it("requires serviceId for deploys action", async () => {
      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "deploys", ownerId: null, resourceIds: null, serviceId: null,
        startTime: null, endTime: null, level: null, text: null, limit: null,
      }, toolCtx);
      expect(result.error).toContain("serviceId");
    });

    it("handles Render API error gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const tool = buildRenderServiceTool();
      const result = await tool.execute({
        action: "deploys", ownerId: null, resourceIds: null, serviceId: "srv-abc",
        startTime: null, endTime: null, level: null, text: null, limit: null,
      }, toolCtx);
      expect(result.error).toContain("Network error");
    });
  });
});
