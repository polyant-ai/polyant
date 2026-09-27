// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnauthorizedException } from "@nestjs/common";

/**
 * Unit tests for the validateAuth() method on OpenAIController.
 *
 * Covers:
 * - #38: fail-secure when authEnabled=true but no API key configured
 * - Bearer token validation with timing-safe comparison
 * - Auth-disabled pass-through
 */

// ---------------------------------------------------------------------------
// Mock resolveInstanceConfig + findInstanceBySlug
// ---------------------------------------------------------------------------

const { mockResolveInstanceConfig, mockFindInstanceBySlug } = vi.hoisted(() => ({
  mockResolveInstanceConfig: vi.fn(),
  mockFindInstanceBySlug: vi.fn(),
}));

vi.mock("../../instances/config-resolver.js", () => ({
  resolveInstanceConfig: mockResolveInstanceConfig,
}));

vi.mock("../../instances/store.js", () => ({
  findInstanceBySlug: mockFindInstanceBySlug,
}));

// Mock OpenAIService to avoid its dependencies
vi.mock("./openai.service.js", () => ({
  OpenAIService: vi.fn().mockImplementation(() => ({
    listInstances: vi.fn().mockResolvedValue([]),
  })),
}));

// ---------------------------------------------------------------------------
// Import and access private method
// ---------------------------------------------------------------------------

import { OpenAIController } from "./openai.controller.js";

function callValidateAuth(
  controller: OpenAIController,
  instanceSlug: string,
  authHeader?: string,
): Promise<void> {
  return (controller as any).validateAuth(instanceSlug, authHeader);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIController.validateAuth — auth bypass protection (#38)", () => {
  let controller: OpenAIController;

  beforeEach(() => {
    vi.clearAllMocks();
    // Return a valid instance so validateAuth proceeds to config checks
    mockFindInstanceBySlug.mockResolvedValue({ id: "test-id", slug: "my-bot", status: "active" });
    controller = new (OpenAIController as any)({});
  });

  it("passes when auth is not enabled", async () => {
    mockResolveInstanceConfig.mockResolvedValue({
      authEnabled: false,
      authApiKey: undefined,
    });

    await expect(callValidateAuth(controller, "my-bot")).resolves.toBeUndefined();
  });

  it("throws UnauthorizedException when authEnabled but no API key configured (#38)", async () => {
    mockResolveInstanceConfig.mockResolvedValue({
      authEnabled: true,
      authApiKey: undefined,
    });

    await expect(callValidateAuth(controller, "my-bot")).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(callValidateAuth(controller, "my-bot")).rejects.toThrow(
      "Auth enabled but no API key configured",
    );
  });

  it("throws UnauthorizedException when authEnabled but authApiKey is empty string", async () => {
    mockResolveInstanceConfig.mockResolvedValue({
      authEnabled: true,
      authApiKey: "",
    });

    await expect(callValidateAuth(controller, "my-bot")).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("throws UnauthorizedException when Bearer header is missing", async () => {
    mockResolveInstanceConfig.mockResolvedValue({
      authEnabled: true,
      authApiKey: "secret-key-123",
    });

    await expect(callValidateAuth(controller, "my-bot")).rejects.toThrow(
      "Missing Bearer token",
    );
  });

  it("throws UnauthorizedException when Bearer header is malformed", async () => {
    mockResolveInstanceConfig.mockResolvedValue({
      authEnabled: true,
      authApiKey: "secret-key-123",
    });

    await expect(
      callValidateAuth(controller, "my-bot", "Basic abc123"),
    ).rejects.toThrow("Missing Bearer token");
  });

  it("throws UnauthorizedException when API key does not match", async () => {
    mockResolveInstanceConfig.mockResolvedValue({
      authEnabled: true,
      authApiKey: "correct-key",
    });

    await expect(
      callValidateAuth(controller, "my-bot", "Bearer wrong-key"),
    ).rejects.toThrow("Invalid API key");
  });

  it("passes when API key matches", async () => {
    mockResolveInstanceConfig.mockResolvedValue({
      authEnabled: true,
      authApiKey: "secret-key-123",
    });

    await expect(
      callValidateAuth(controller, "my-bot", "Bearer secret-key-123"),
    ).resolves.toBeUndefined();
  });

  it("rejects keys of different length (timing-safe)", async () => {
    mockResolveInstanceConfig.mockResolvedValue({
      authEnabled: true,
      authApiKey: "short",
    });

    await expect(
      callValidateAuth(controller, "my-bot", "Bearer a-much-longer-key-that-differs"),
    ).rejects.toThrow("Invalid API key");
  });
});

describe("OpenAIController — streaming request refused by the pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindInstanceBySlug.mockResolvedValue({ id: "test-id", slug: "my-bot", status: "active" });
    mockResolveInstanceConfig.mockResolvedValue({ authEnabled: false });
  });

  it("answers an ordinary error, having written nothing of the stream yet", async () => {
    const { BadRequestException } = await import("@nestjs/common");
    const refusal = new BadRequestException("no");
    const controller = new (OpenAIController as any)({
      chatCompletionStream: vi.fn().mockRejectedValue(refusal),
    });
    const res = { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), json: vi.fn() };

    await expect(
      controller.chatCompletions(
        { model: "my-bot", stream: true, messages: [{ role: "user", content: "ciao" }] },
        res,
      ),
    ).rejects.toBe(refusal);

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });
});
