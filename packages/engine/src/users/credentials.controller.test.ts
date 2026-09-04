// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditLog } = vi.hoisted(() => ({ mockAuditLog: vi.fn() }));

vi.mock("../management-audit/management-audit-logger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../management-audit/management-audit-logger.js")>();
  return { ...actual, createManagementAuditLogger: () => ({ log: mockAuditLog }) };
});

vi.mock("../config.js", () => ({
  config: {
    auth: {
      internalSecret: "internal-secret-1234",
      platformAdminEmail: "boss@example.com",
    },
  },
}));

vi.mock("../organizations/organizations.store.js", () => ({
  ensureConfiguredPlatformAdminOwner: vi.fn(),
}));

vi.mock("./users.service.js", () => ({
  UsersService: class UsersService {},
}));

import { CredentialsController } from "./credentials.controller.js";
import { ensureConfiguredPlatformAdminOwner } from "../organizations/organizations.store.js";
import { ManagementAuditAction } from "../management-audit/management-audit-logger.js";

const ensureOwner = ensureConfiguredPlatformAdminOwner as ReturnType<typeof vi.fn>;

describe("CredentialsController bootstrap-owner", () => {
  const controller = new CredentialsController({} as never);

  beforeEach(() => {
    vi.clearAllMocks();
    ensureOwner.mockResolvedValue("org-default");
  });

  it("bootstraps the exact configured platform-admin email case-insensitively", async () => {
    await expect(
      controller.bootstrapOwner("internal-secret-1234", { email: " Boss@Example.com " }),
    ).resolves.toEqual({ organizationId: "org-default" });

    expect(ensureOwner).toHaveBeenCalledWith("boss@example.com");
  });

  it("audits the platform-admin bootstrap", async () => {
    await controller.bootstrapOwner("internal-secret-1234", { email: "boss@example.com" });

    expect(mockAuditLog).toHaveBeenCalledWith({
      action: ManagementAuditAction.PlatformAdminBootstrap,
      actor: undefined,
      targetType: "user",
      targetId: "boss@example.com",
      metadata: { organizationId: "org-default" },
    });
  });

  it("does not audit a rejected bootstrap", async () => {
    await expect(
      controller.bootstrapOwner("internal-secret-1234", { email: "member@example.com" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("refuses an arbitrary email even with the internal secret", async () => {
    await expect(
      controller.bootstrapOwner("internal-secret-1234", { email: "member@example.com" }),
    ).rejects.toMatchObject({ status: 401 });

    expect(ensureOwner).not.toHaveBeenCalled();
  });

  it("rejects malformed authenticated input with BadRequest instead of throwing", async () => {
    await expect(
      controller.bootstrapOwner("internal-secret-1234", null as never),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      controller.bootstrapOwner("internal-secret-1234", { email: 42 as never }),
    ).rejects.toMatchObject({ status: 400 });
    expect(ensureOwner).not.toHaveBeenCalled();
  });
});
