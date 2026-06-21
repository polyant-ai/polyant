// SPDX-License-Identifier: AGPL-3.0-or-later

const mockAssertSafeUrl = vi.hoisted(() => vi.fn());
const mockPinnedLookup = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubGlobal("fetch", mockFetch);
vi.mock("../../utils/url-safety.js", () => ({
  assertSafeUrl: mockAssertSafeUrl,
  pinnedLookup: mockPinnedLookup,
}));
// Agent is used as a constructor: `new Agent({...})`
vi.mock("undici", () => ({
  Agent: class MockAgent { constructor() { /* noop */ } },
}));
vi.mock("./registry.js", () => ({
  registerTool: vi.fn(),
}));
vi.mock("../../utils/error.js", () => ({
  errMsg: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

import { registerTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";
import "./http-request.tool.js";

const def = vi.mocked(registerTool).mock.calls[0][0];

function buildTool(secretOverrides?: Record<string, string>) {
  const ctx = {
    agentId: "test-instance",
    secrets: { http_api_key: "test-api-key-123", ...secretOverrides },
    audit: createMockAudit(),
    conversationId: "conv-1",
  } as any;
  return { execute: def.create(ctx).execute, audit: ctx.audit };
}

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSafeUrl.mockResolvedValue("1.2.3.4");
  mockPinnedLookup.mockReturnValue(vi.fn());
});

describe("httpRequest tool", () => {
  // Registration
  it("registers with correct metadata", () => {
    expect(def.name).toBe("httpRequest");
    expect(def.category).toBe("integration");
    // Both declared secrets are optional so the tool remains available even
    // without them (auth is opt-in via authStyle; the domain allowlist is
    // an additional SSRF gate, off by default).
    const specs = (def.requiredSecrets ?? []).filter(
      (s): s is Exclude<typeof s, string> => typeof s !== "string",
    );
    expect(specs.map((s) => s.key).sort()).toEqual(["http_allowed_domains", "http_api_key"]);
    expect(specs.every((s) => s.optional === true)).toBe(true);
  });

  // Happy path POST with explicit bearer
  it("injects Authorization Bearer when authStyle is bearer", async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));
    const { execute } = buildTool();

    const result = await execute({
      url: "https://api.example.com/webhook",
      method: "POST",
      body: '{"event":"test"}',
      authStyle: "bearer",
    });

    expect(mockAssertSafeUrl).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/webhook",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key-123",
        }),
        body: JSON.stringify({ event: "test" }),
      }),
    );
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
  });

  // PUT
  it("sends PUT requests", async () => {
    mockFetch.mockResolvedValue(mockResponse({ updated: true }));
    const { execute } = buildTool();

    const result = await execute({
      url: "https://api.example.com/items/1",
      method: "PUT",
      body: '{"status":"done"}',
      authStyle: null,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "PUT" }),
    );
    expect(result).toMatchObject({ status: 200 });
  });

  // PATCH
  it("sends PATCH requests", async () => {
    mockFetch.mockResolvedValue(mockResponse({ patched: true }));
    const { execute } = buildTool();

    const result = await execute({
      url: "https://api.example.com/items/1",
      method: "PATCH",
      body: '{"field":"value"}',
      authStyle: "api-key",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "X-API-Key": "test-api-key-123" }),
      }),
    );
    expect(result).toMatchObject({ status: 200 });
  });

  // DELETE
  it("sends DELETE requests", async () => {
    mockFetch.mockResolvedValue(mockResponse({}, 204));
    const { execute } = buildTool();

    const result = await execute({
      url: "https://api.example.com/items/1",
      method: "DELETE",
      body: "{}",
      authStyle: null,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result).toMatchObject({ status: 204 });
  });

  // No authStyle, no secret — no auth header, no error
  it("sends request without auth header when authStyle is null and no secret is configured", async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));
    const ctx = {
      agentId: "test",
      secrets: {},
      audit: createMockAudit(),
    } as any;
    const { execute } = def.create(ctx);

    const result = await execute({
      url: "https://webhook.site/test",
      method: "POST",
      body: '{"test":true}',
      authStyle: null,
    });

    const fetchCall = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(fetchCall.headers).toEqual({ "Content-Type": "application/json" });
    expect(fetchCall.headers).not.toHaveProperty("Authorization");
    expect(fetchCall.headers).not.toHaveProperty("X-API-Key");
    expect(result).toMatchObject({ status: 200 });
  });

  // authStyle "none" string — accepted as synonym of null via Zod preprocess
  it("accepts authStyle string 'none' as equivalent to null (via Zod preprocess)", () => {
    const ctx = {
      agentId: "test",
      secrets: {},
      audit: createMockAudit(),
    } as any;
    const { parameters } = def.create(ctx);

    // Direct schema validation — Zod preprocess normalizes "none" → null
    const parsed = parameters.parse({
      url: "https://webhook.site/test",
      method: "POST",
      body: '{"test":true}',
      authStyle: "none",
    });
    expect(parsed.authStyle).toBeNull();

    // Variants: empty string, whitespace, mixed case
    expect(parameters.parse({ url: "https://x.com", method: "POST", body: "{}", authStyle: "" }).authStyle).toBeNull();
    expect(parameters.parse({ url: "https://x.com", method: "POST", body: "{}", authStyle: "  None  " }).authStyle).toBeNull();
    expect(parameters.parse({ url: "https://x.com", method: "POST", body: "{}", authStyle: null }).authStyle).toBeNull();

    // Valid enum values pass through unchanged
    expect(parameters.parse({ url: "https://x.com", method: "POST", body: "{}", authStyle: "bearer" }).authStyle).toBe("bearer");
    expect(parameters.parse({ url: "https://x.com", method: "POST", body: "{}", authStyle: "api-key" }).authStyle).toBe("api-key");

    // Invalid arbitrary strings still rejected
    expect(() => parameters.parse({ url: "https://x.com", method: "POST", body: "{}", authStyle: "foo" })).toThrow();
  });

  // authStyle bearer requested but secret missing — silent fallback to no auth
  it("sends request without auth header when authStyle is bearer but secret is missing", async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));
    const ctx = {
      agentId: "test",
      secrets: {},
      audit: createMockAudit(),
    } as any;
    const { execute } = def.create(ctx);

    const result = await execute({
      url: "https://api.example.com/webhook",
      method: "POST",
      body: "{}",
      authStyle: "bearer",
    });

    const fetchCall = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(fetchCall.headers).not.toHaveProperty("Authorization");
    expect(fetchCall.headers).not.toHaveProperty("X-API-Key");
    expect(result).toMatchObject({ status: 200 });
  });

  // API key auth style
  it("uses X-API-Key header when authStyle is api-key", async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));
    const { execute } = buildTool();

    await execute({
      url: "https://api.example.com/webhook",
      method: "POST",
      body: "{}",
      authStyle: "api-key",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-API-Key": "test-api-key-123",
        }),
      }),
    );
  });

  // Runtime URL-prefix validation (replaces Zod .url() — OpenAI strict-mode incompat).
  // Invalid URL: no http(s):// prefix → error before fetch, no audit log, no SSRF check.
  it("returns error when URL does not start with http:// or https://", async () => {
    const { execute, audit } = buildTool();

    const result = await execute({
      url: "ftp://example.com/file",
      method: "POST",
      body: "{}",
      authStyle: null,
    }) as { error: string };

    expect(result.error).toContain("http://");
    expect(result.error).toContain("https://");
    // Validation happens BEFORE SSRF check and before fetch.
    expect(mockAssertSafeUrl).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    // No audit log on pre-flight schema rejection (mirrors Zod parse failure).
    expect(audit.log).not.toHaveBeenCalled();
  });

  // Runtime URL-prefix validation: http:// is also accepted (not just https://).
  it("accepts http:// URLs (runtime check allows both schemes)", async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));
    const { execute } = buildTool();

    const result = await execute({
      url: "http://internal-webhook.example.com/hook",
      method: "POST",
      body: '{"event":"test"}',
      authStyle: null,
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 200 });
  });

  // SSRF blocked
  it("returns error when URL is SSRF-blocked", async () => {
    mockAssertSafeUrl.mockRejectedValue(new Error("Private IP blocked"));
    const { execute } = buildTool();

    const result = await execute({
      url: "http://192.168.1.1/internal",
      method: "POST",
      body: "{}",
      authStyle: null,
    }) as { error: string };

    expect(result.error).toContain("Private IP blocked");
  });

  // Non-2xx response (not treated as tool error)
  it("returns non-2xx responses without error field", async () => {
    mockFetch.mockResolvedValue(mockResponse({ message: "not found" }, 404));
    const { execute } = buildTool();

    const result = await execute({
      url: "https://api.example.com/missing",
      method: "POST",
      body: "{}",
      authStyle: null,
    }) as { status: number; body: unknown };

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ message: "not found" });
  });

  // Body truncation
  it("truncates large response bodies", async () => {
    const largeBody = "x".repeat(20_000);
    mockFetch.mockResolvedValue(mockResponse(largeBody));
    const { execute } = buildTool();

    const result = await execute({
      url: "https://api.example.com/large",
      method: "POST",
      body: "{}",
      authStyle: null,
    }) as { truncated: boolean; body: string };

    expect(result.truncated).toBe(true);
    expect((result.body as string).length).toBeLessThanOrEqual(16_384);
  });

  // Audit logging
  it("logs audit on success", async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));
    const { execute, audit } = buildTool();

    await execute({
      url: "https://api.example.com/test",
      method: "POST",
      body: '{"a":1}',
      authStyle: null,
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration.httpRequest",
        success: true,
      }),
    );
  });

  it("logs audit on error", async () => {
    mockFetch.mockRejectedValue(new Error("Network timeout"));
    const { execute, audit } = buildTool();

    await execute({
      url: "https://api.example.com/slow",
      method: "POST",
      body: "{}",
      authStyle: null,
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration.httpRequest",
        success: false,
        error: "Network timeout",
      }),
    );
  });

  // Network error — surfaces the deepest cause, not just "fetch failed"
  it("unwraps Node 22 fetch failed errors and surfaces the underlying cause", async () => {
    // Simulate Node 22's TypeError: fetch failed wrapping a real cause
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), {
      code: "ENOTFOUND",
      name: "Error",
    });
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause });
    mockFetch.mockRejectedValue(wrapped);
    const { execute } = buildTool();

    const result = await execute({
      url: "https://api.example.com/down",
      method: "POST",
      body: "{}",
      authStyle: null,
    }) as { error: string; cause?: string; errorCode?: string };

    // Deepest cause becomes the primary message
    expect(result.error).toContain("ENOTFOUND");
    // Trace includes both outer "fetch failed" and inner cause
    expect(result.cause).toContain("fetch failed");
    expect(result.cause).toContain("ENOTFOUND");
    expect(result.errorCode).toBe("ENOTFOUND");
  });

  // Plain network error (no cause chain) still returns the bare message
  it("returns plain message when error has no cause chain", async () => {
    mockFetch.mockRejectedValue(new Error("plain failure"));
    const { execute } = buildTool();

    const result = await execute({
      url: "https://api.example.com/down",
      method: "POST",
      body: "{}",
      authStyle: null,
    }) as { error: string; cause: string };

    expect(result.error).toBe("plain failure");
    expect(result.cause).toBe("plain failure");
  });

  // Audit log on fetch failure includes trace + error code
  it("audit logs fetch failure with trace and error code", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
      code: "ECONNREFUSED",
    });
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause });
    mockFetch.mockRejectedValue(wrapped);
    const { execute, audit } = buildTool();

    await execute({
      url: "https://api.example.com/down",
      method: "POST",
      body: "{}",
      authStyle: null,
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration.httpRequest",
        success: false,
        details: expect.objectContaining({
          errorCode: "ECONNREFUSED",
          trace: expect.stringContaining("fetch failed"),
        }),
      }),
    );
  });
});
