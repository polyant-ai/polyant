// SPDX-License-Identifier: AGPL-3.0-or-later

// RBAC Stream 7: destructive secret mutations must leave a management-audit row
// carrying actor + target + action. The secret VALUE is never audited.

const {
  mockSetSecret,
  mockListSecretKeys,
  mockDeleteSecret,
  mockInvalidateCache,
  mockFindInstanceOrFail,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockSetSecret: vi.fn(),
  mockListSecretKeys: vi.fn(),
  mockDeleteSecret: vi.fn(),
  mockInvalidateCache: vi.fn(),
  mockFindInstanceOrFail: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock("../../instances/secrets.store.js", () => ({
  setSecret: mockSetSecret,
  listSecretKeys: mockListSecretKeys,
  deleteSecret: mockDeleteSecret,
}));
vi.mock("../../instances/config-resolver.js", () => ({
  invalidateInstanceConfigCache: mockInvalidateCache,
}));
vi.mock("./instance-helpers.js", () => ({ findInstanceOrFail: mockFindInstanceOrFail }));
vi.mock("../../management-audit/management-audit-logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../management-audit/management-audit-logger.js")>();
  return {
    ...actual,
    createManagementAuditLogger: () => ({ log: mockAuditLog }),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InstanceSecretsController } from "./instance-secrets.controller.js";
import { ManagementAuditAction } from "../../management-audit/management-audit-logger.js";

const actor = { userId: "u-2", email: "owner@example.com", principalType: "user" as const };
// The audit logger deliberately projects the principal to { userId, email } only.
const expectedActor = { userId: "u-2", email: "owner@example.com" };

describe("InstanceSecretsController management audit", () => {
  let controller: InstanceSecretsController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InstanceSecretsController();
    mockFindInstanceOrFail.mockResolvedValue({ id: "uuid-1", slug: "support-bot" });
    mockListSecretKeys.mockResolvedValue([]);
    mockSetSecret.mockResolvedValue(undefined);
    mockDeleteSecret.mockResolvedValue(undefined);
  });

  it("audits secret.write per key, never carrying the value", async () => {
    await controller.setSecrets(
      "support-bot",
      { secrets: [{ key: "openai_api_key", value: "sk-super-secret" }] },
      actor,
    );

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ManagementAuditAction.SecretWrite,
        actor: expectedActor,
        targetType: "secret",
        targetId: "openai_api_key",
      }),
    );
    // The plaintext secret value must never appear in any audit argument.
    const serialized = JSON.stringify(mockAuditLog.mock.calls);
    expect(serialized).not.toContain("sk-super-secret");
  });

  it("audits secret.delete with actor + target", async () => {
    await controller.removeSecret("support-bot", "tavily_api_key", actor);

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ManagementAuditAction.SecretDelete,
        actor: expectedActor,
        targetType: "secret",
        targetId: "tavily_api_key",
      }),
    );
  });
});
