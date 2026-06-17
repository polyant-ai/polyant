// SPDX-License-Identifier: AGPL-3.0-or-later

// RBAC Stream 7: destructive agent mutations must leave a management-audit row
// carrying actor + target + action.

const {
  mockCreateInstance,
  mockDeleteInstance,
  mockSeedPrompts,
  mockSeedTools,
  mockSeedSkills,
  mockInvalidateCache,
  mockProviderConfigs,
  mockStopAll,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockCreateInstance: vi.fn(),
  mockDeleteInstance: vi.fn(),
  mockSeedPrompts: vi.fn(),
  mockSeedTools: vi.fn(),
  mockSeedSkills: vi.fn(),
  mockInvalidateCache: vi.fn(),
  mockProviderConfigs: {
    openai: {
      tiers: { fast: "gpt-4o-mini", standard: "gpt-4o", heavy: "o1" },
      costPerMillionTokens: { "gpt-4o-mini": { input: 0.15, output: 0.6 } },
    },
  },
  mockStopAll: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock("../../instances/store.js", () => ({
  listAllInstances: vi.fn(),
  findInstanceBySlug: vi.fn(),
  createInstance: mockCreateInstance,
  updateInstance: vi.fn(),
  deleteInstance: mockDeleteInstance,
}));
vi.mock("../../instances/prompts.store.js", () => ({ seedInstancePrompts: mockSeedPrompts }));
vi.mock("../../instances/instance-tools.store.js", () => ({ seedInstanceTools: mockSeedTools }));
vi.mock("../../instances/instance-skills.store.js", () => ({ seedInstanceSkills: mockSeedSkills }));
vi.mock("../../instances/config-resolver.js", () => ({
  invalidateInstanceConfigCache: mockInvalidateCache,
}));
vi.mock("../../ai-gateway/config.js", () => ({ providerConfigs: mockProviderConfigs }));
vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: { stopAllForInstance: mockStopAll },
}));
vi.mock("../../management-audit/management-audit-logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../management-audit/management-audit-logger.js")>();
  return {
    ...actual,
    createManagementAuditLogger: () => ({ log: mockAuditLog }),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InstancesController } from "./instances.controller.js";
import { ManagementAuditAction } from "../../management-audit/management-audit-logger.js";

const actor = { userId: "u-1", email: "admin@example.com" };

describe("InstancesController management audit", () => {
  let controller: InstancesController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InstancesController();
    mockCreateInstance.mockResolvedValue({ id: "uuid-1", slug: "new-one", name: "New", updatedAt: new Date() });
    mockDeleteInstance.mockResolvedValue(true);
    mockStopAll.mockResolvedValue(undefined);
  });

  it("audits agent.create with actor + target", async () => {
    await controller.create({ slug: "new-one", name: "New" }, actor);

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ManagementAuditAction.AgentCreate,
        actor,
        targetType: "agent",
        targetId: "new-one",
      }),
    );
  });

  it("audits agent.delete with actor + target", async () => {
    await controller.remove("doomed", actor);

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ManagementAuditAction.AgentDelete,
        actor,
        targetType: "agent",
        targetId: "doomed",
      }),
    );
  });

  it("does not audit a delete that hits nothing (404)", async () => {
    mockDeleteInstance.mockResolvedValue(false);
    await expect(controller.remove("ghost", actor)).rejects.toThrow();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
