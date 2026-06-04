// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/utils/pipeline-logger.js", () => ({
  pipelineLog: {
    toolCall: vi.fn(),
    toolResult: vi.fn(),
  },
}));

vi.mock("../../utils/url-safety.js", () => ({
  assertSafeUrl: vi.fn().mockResolvedValue({ address: "1.2.3.4", family: 4 }),
  pinnedLookup: vi.fn().mockReturnValue((_hostname: string, _opts: unknown, cb: any) => cb(null, "1.2.3.4", 4)),
}));

vi.mock("undici", () => {
  // Must use `function` (not arrow) so it's valid as a constructor with `new`.
  function MockAgent() { /* noop */ }
  return { Agent: MockAgent };
});

import "./curl.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

const dummyCtx = {
  instanceId: "test",
  audit: createMockAudit(),
} as any;

function createMockResponse(
  body: string,
  opts?: { status?: number; statusText?: string; headers?: Record<string, string> },
) {
  const headers = new Headers(opts?.headers ?? { "content-type": "text/html" });
  return {
    status: opts?.status ?? 200,
    statusText: opts?.statusText ?? "OK",
    text: vi.fn().mockResolvedValue(body),
    headers,
  } as unknown as Response;
}

const toolCtx = { toolCallId: "tc-1", messages: [] } as any;

describe("curl", () => {
  const def = getToolRegistry().get("curl")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const curl = buildTool(def, dummyCtx) as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct description and parameter schema", () => {
    expect(curl.description).toBeDefined();
    expect(curl.inputSchema).toBeDefined();
  });

  it("performs GET request and returns structured response", async () => {
    mockFetch.mockResolvedValue(
      createMockResponse('{"data": 1}', {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await curl.execute({ url: "https://api.example.com/data", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null }, toolCtx);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/data",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"data": 1}');
    expect(result.truncated).toBe(false);
    expect(result.headers).toHaveProperty("content-type", "application/json");
  });

  it("appends query params to URL", async () => {
    mockFetch.mockResolvedValue(createMockResponse("ok"));

    await curl.execute(
      { url: "https://api.example.com/search", headers: null, queryParams: { q: "test", page: "1" }, maxBodySize: null, timeoutMs: null },
      toolCtx,
    );

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=test");
    expect(calledUrl).toContain("page=1");
  });

  it("passes custom headers to fetch", async () => {
    mockFetch.mockResolvedValue(createMockResponse("ok"));

    await curl.execute(
      { url: "https://api.example.com/data", headers: { Authorization: "Bearer token123" }, queryParams: null, maxBodySize: null, timeoutMs: null },
      toolCtx,
    );

    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.headers).toEqual({ Authorization: "Bearer token123" });
  });

  it("truncates body exceeding maxBodySize", async () => {
    const longBody = "x".repeat(1000);
    mockFetch.mockResolvedValue(createMockResponse(longBody));

    const result = await curl.execute({ url: "https://example.com", headers: null, queryParams: null, maxBodySize: 100, timeoutMs: null }, toolCtx);

    expect(result.body).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.bodyLength).toBe(1000);
  });

  it("returns error object on network failure without throwing", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await curl.execute({ url: "https://unreachable.example.com", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null }, toolCtx);

    expect(result.error).toBe("ECONNREFUSED");
    expect(result.status).toBeNull();
    expect(result.body).toBeNull();
  });

  it("handles non-200 status codes as valid responses", async () => {
    mockFetch.mockResolvedValue(
      createMockResponse("Not Found", { status: 404, statusText: "Not Found" }),
    );

    const result = await curl.execute({ url: "https://example.com/missing", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null }, toolCtx);

    expect(result.status).toBe(404);
    expect(result.statusText).toBe("Not Found");
    expect(result.body).toBe("Not Found");
    expect(result).not.toHaveProperty("error");
  });

  it("performs POST request simulation (tool always uses GET, body ignored)", async () => {
    mockFetch.mockResolvedValue(
      createMockResponse('{"created": true}', {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await curl.execute(
      {
        url: "https://api.example.com/items",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
        queryParams: null,
        maxBodySize: null,
        timeoutMs: null,
      },
      toolCtx,
    );

    // The tool always sends GET — verify headers are forwarded
    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.method).toBe("GET");
    expect(fetchOptions.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    });
    expect(result.status).toBe(201);
    expect(result.body).toBe('{"created": true}');
  });

  it("sends multiple custom headers together", async () => {
    mockFetch.mockResolvedValue(createMockResponse("ok"));

    await curl.execute(
      {
        url: "https://api.example.com/data",
        headers: {
          Authorization: "Bearer token123",
          Accept: "application/json",
          "X-Custom-Header": "custom-value",
        },
        queryParams: null,
        maxBodySize: null,
        timeoutMs: null,
      },
      toolCtx,
    );

    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.headers).toEqual({
      Authorization: "Bearer token123",
      Accept: "application/json",
      "X-Custom-Header": "custom-value",
    });
  });

  it("handles timeout via AbortSignal", async () => {
    // Simulate an abort error (same shape as AbortSignal.timeout)
    mockFetch.mockRejectedValue(new DOMException("The operation was aborted", "TimeoutError"));

    const result = await curl.execute(
      { url: "https://slow.example.com/api", headers: null, queryParams: null, maxBodySize: null, timeoutMs: 100 },
      toolCtx,
    );

    expect(result.error).toBeDefined();
    expect(result.status).toBeNull();
    expect(result.body).toBeNull();
  });

  it("passes timeoutMs to AbortSignal.timeout", async () => {
    const spyTimeout = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockResolvedValue(createMockResponse("ok"));

    await curl.execute(
      { url: "https://api.example.com/data", headers: null, queryParams: null, maxBodySize: null, timeoutMs: 5000 },
      toolCtx,
    );

    expect(spyTimeout).toHaveBeenCalledWith(5000);
    spyTimeout.mockRestore();
  });

  it("uses default timeout when timeoutMs is null", async () => {
    const spyTimeout = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockResolvedValue(createMockResponse("ok"));

    await curl.execute(
      { url: "https://api.example.com/data", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null },
      toolCtx,
    );

    expect(spyTimeout).toHaveBeenCalledWith(15_000);
    spyTimeout.mockRestore();
  });

  it("handles non-UTF8 response body (binary-like text)", async () => {
    // fetch().text() decodes as UTF-8 by default; invalid bytes become replacement chars
    const binaryLikeBody = "binary\x00data\uFFFDwith\uFFFDreplacements";
    mockFetch.mockResolvedValue(createMockResponse(binaryLikeBody));

    const result = await curl.execute(
      { url: "https://example.com/binary", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null },
      toolCtx,
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe(binaryLikeBody);
    expect(result.truncated).toBe(false);
  });

  it("handles URL with special characters (encoded properly)", async () => {
    mockFetch.mockResolvedValue(createMockResponse("ok"));

    await curl.execute(
      {
        url: "https://api.example.com/search?q=hello%20world&tag=%23trending",
        headers: null,
        queryParams: null,
        maxBodySize: null,
        timeoutMs: null,
      },
      toolCtx,
    );

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    // URL constructor normalises, but encoded params should be preserved
    expect(calledUrl).toMatch(/q=hello(\+|%20)world/);
    expect(calledUrl).toContain("tag=%23trending");
  });

  it("appends query params to URL that already has query parameters", async () => {
    mockFetch.mockResolvedValue(createMockResponse("ok"));

    await curl.execute(
      {
        url: "https://api.example.com/search?existing=value",
        headers: null,
        queryParams: { added: "new" },
        maxBodySize: null,
        timeoutMs: null,
      },
      toolCtx,
    );

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("existing=value");
    expect(calledUrl).toContain("added=new");
  });

  it("handles empty response body", async () => {
    mockFetch.mockResolvedValue(
      createMockResponse("", { status: 204, statusText: "No Content" }),
    );

    const result = await curl.execute(
      { url: "https://api.example.com/delete-item", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null },
      toolCtx,
    );

    expect(result.status).toBe(204);
    expect(result.body).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.bodyLength).toBe(0);
  });

  it("truncates very large response and includes bodyLength", async () => {
    // Default max is 16384; generate a body larger than that
    const largeBody = "A".repeat(20_000);
    mockFetch.mockResolvedValue(createMockResponse(largeBody));

    const result = await curl.execute(
      { url: "https://example.com/large", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null },
      toolCtx,
    );

    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(16_384);
    expect(result.bodyLength).toBe(20_000);
    // Verify the body is a prefix of the original
    expect(result.body).toBe(largeBody.slice(0, 16_384));
  });

  it("does not truncate response at exactly the limit", async () => {
    const exactBody = "B".repeat(16_384);
    mockFetch.mockResolvedValue(createMockResponse(exactBody));

    const result = await curl.execute(
      { url: "https://example.com/exact", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null },
      toolCtx,
    );

    expect(result.truncated).toBe(false);
    expect(result.body).toHaveLength(16_384);
    expect(result.bodyLength).toBe(16_384);
  });

  it("respects custom maxBodySize for truncation", async () => {
    const body = "C".repeat(500);
    mockFetch.mockResolvedValue(createMockResponse(body));

    const result = await curl.execute(
      { url: "https://example.com/custom", headers: null, queryParams: null, maxBodySize: 200, timeoutMs: null },
      toolCtx,
    );

    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(200);
    expect(result.bodyLength).toBe(500);
  });

  it("returns only interesting headers from the response", async () => {
    mockFetch.mockResolvedValue(
      createMockResponse("ok", {
        headers: {
          "content-type": "text/plain",
          "x-ratelimit-remaining": "42",
          "x-custom-ignored": "ignored",
          "set-cookie": "session=abc",
        },
      }),
    );

    const result = await curl.execute(
      { url: "https://api.example.com/data", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null },
      toolCtx,
    );

    expect(result.headers).toHaveProperty("content-type", "text/plain");
    expect(result.headers).toHaveProperty("x-ratelimit-remaining", "42");
    expect(result.headers).not.toHaveProperty("x-custom-ignored");
    expect(result.headers).not.toHaveProperty("set-cookie");
  });
});
