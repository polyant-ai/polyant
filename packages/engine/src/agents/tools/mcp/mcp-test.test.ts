// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

class FakeUnauthorized extends Error {}
const createMCPClient = vi.fn();
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient, UnauthorizedError: FakeUnauthorized }));

const { testMcpConnection } = await import("./mcp-test.js");

describe("testMcpConnection", () => {
  beforeEach(() => {
    createMCPClient.mockReset();
  });

  it("should_return_tools_and_close_client_on_success", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    createMCPClient.mockResolvedValue({
      tools: async () => ({ create_issue: { description: "d", inputSchema: {}, execute: async () => "ok" } }),
      close,
    });
    const result = await testMcpConnection({ url: "https://x", authMode: "static", config: {} });
    expect(result).toEqual({ ok: true, tools: ["create_issue"] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("should_close_client_and_report_error_when_tools_enumeration_throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    createMCPClient.mockResolvedValue({
      tools: async () => {
        throw new Error("enumeration failed");
      },
      close,
    });
    const result = await testMcpConnection({ url: "https://x", authMode: "static", config: {} });
    expect(result).toEqual({ ok: false, error: "enumeration failed" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("should_report_requiresOAuth_when_createMCPClient_throws_unauthorized", async () => {
    createMCPClient.mockRejectedValue(new FakeUnauthorized());
    const result = await testMcpConnection({ url: "https://x", authMode: "static", config: {} });
    expect(result).toEqual({ ok: true, requiresOAuth: true });
  });
});
