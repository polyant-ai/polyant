// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";

/**
 * Unit tests for A2aController — the a2a_enabled gate + auth ordering.
 * Does NOT exercise the real SDK Express middleware (jsonRpcHandler /
 * agentCardHandler) — that round trip is verified live in the manual
 * e2e smoke task, not here.
 */

vi.mock("../../instances/config-resolver.js", () => ({
  resolveInstanceConfig: vi.fn(),
}));
vi.mock("../openai/instance-api-key-auth.js", () => ({
  validateInstanceApiKey: vi.fn(async () => {}),
}));

import { resolveInstanceConfig } from "../../instances/config-resolver.js";
import { validateInstanceApiKey } from "../openai/instance-api-key-auth.js";
import { A2aController } from "./a2a.controller.js";

function res() {
  return { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), json: vi.fn() } as never;
}
function req(auth?: string) {
  return { headers: auth ? { authorization: auth } : {}, method: "POST", body: {} } as never;
}

describe("A2aController", () => {
  let registry: { getHandler: ReturnType<typeof vi.fn> };
  let controller: A2aController;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = { getHandler: vi.fn(async () => ({})) };
    controller = new A2aController(registry as never);
  });

  it("should_404_the_card_when_a2a_disabled", async () => {
    vi.mocked(resolveInstanceConfig).mockResolvedValue({ a2aEnabled: false } as never);
    await expect(controller.agentCard("acme", req(), res())).rejects.toBeInstanceOf(NotFoundException);
    expect(registry.getHandler).not.toHaveBeenCalled();
  });

  it("should_404_jsonrpc_when_a2a_disabled_before_touching_auth", async () => {
    vi.mocked(resolveInstanceConfig).mockResolvedValue({ a2aEnabled: false } as never);
    await expect(controller.jsonrpc("acme", req("Bearer k"), res())).rejects.toBeInstanceOf(NotFoundException);
    expect(validateInstanceApiKey).not.toHaveBeenCalled();
  });

  it("should_enforce_api_key_on_jsonrpc_when_enabled", async () => {
    vi.mocked(resolveInstanceConfig).mockResolvedValue({ a2aEnabled: true } as never);
    await controller.jsonrpc("acme", req("Bearer k"), res());
    expect(validateInstanceApiKey).toHaveBeenCalledWith("acme", "Bearer k");
    expect(registry.getHandler).toHaveBeenCalled();
  });
});
