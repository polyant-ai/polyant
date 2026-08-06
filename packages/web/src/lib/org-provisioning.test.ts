// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sign-in org resolution is a LOOKUP for everyone except the one exact address
 * configured as the platform administrator.
 *
 * It used to provision: a user with no membership got the default-org membership
 * plus the OWNER binding, so passing the sign-in domain allowlist made you an
 * Owner of the organization. On a deployment whose allowlist is a company domain,
 * that was every employee. Membership is now granted deliberately through
 * `PUT /api/organizations/:orgSlug/members/:userId`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveSignInOrgId,
  type OrgProvisioningPort,
} from "./org-provisioning";

function buildPort(overrides: Partial<OrgProvisioningPort> = {}): OrgProvisioningPort {
  return {
    findUserOrgId: vi.fn(async () => "org-default"),
    ensureConfiguredPlatformAdminOwner: vi.fn(async () => "org-default"),
    ...overrides,
  };
}

describe("resolveSignInOrgId", () => {
  it("returns the user's existing org membership", async () => {
    const port = buildPort({ findUserOrgId: vi.fn(async () => "org-existing") });

    await expect(
      resolveSignInOrgId(port, {
        userId: "user-1",
        email: "member@example.com",
      }),
    ).resolves.toBe("org-existing");
  });

  it("returns null for a user with no membership, and provisions nothing", async () => {
    const port = buildPort({ findUserOrgId: vi.fn(async () => null) });

    await expect(
      resolveSignInOrgId(port, {
        userId: "user-1",
        email: "member@example.com",
      }),
    ).resolves.toBeNull();
    // The whole point: no membership is a valid answer, not a condition to fix by
    // granting one. `null` reaches the engine as `organization: null` and the
    // panel tells the user to ask an administrator.
    expect(port.findUserOrgId).toHaveBeenCalledWith("user-1");
    expect(port.ensureConfiguredPlatformAdminOwner).not.toHaveBeenCalled();
  });

  it("bootstraps only the exact configured platform-admin email at first sign-in", async () => {
    const port = buildPort({
      findUserOrgId: vi.fn(async () => null),
      ensureConfiguredPlatformAdminOwner: vi.fn(async () => "org-default"),
    });

    await expect(
      resolveSignInOrgId(port, {
        userId: "user-1",
        email: "Boss@Example.com",
        platformAdminEmail: " boss@example.com ",
      }),
    ).resolves.toBe("org-default");

    expect(port.ensureConfiguredPlatformAdminOwner).toHaveBeenCalledWith(
      "boss@example.com",
    );
    expect(port.findUserOrgId).toHaveBeenCalledWith("user-1");
  });

  it("keeps an existing configured admin membership without calling bootstrap", async () => {
    const port = buildPort({
      findUserOrgId: vi.fn(async () => "org-existing"),
    });

    await expect(
      resolveSignInOrgId(port, {
        userId: "user-1",
        email: "boss@example.com",
        platformAdminEmail: "boss@example.com",
      }),
    ).resolves.toBe("org-existing");

    expect(port.ensureConfiguredPlatformAdminOwner).not.toHaveBeenCalled();
  });

  it("falls back to a membership that appears while configured-admin bootstrap is unavailable", async () => {
    const port = buildPort({
      findUserOrgId: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("org-existing"),
      ensureConfiguredPlatformAdminOwner: vi.fn(async () => null),
    });

    await expect(
      resolveSignInOrgId(port, {
        userId: "user-1",
        email: "boss@example.com",
        platformAdminEmail: "boss@example.com",
      }),
    ).resolves.toBe("org-existing");

    expect(port.ensureConfiguredPlatformAdminOwner).toHaveBeenCalledWith(
      "boss@example.com",
    );
    expect(port.findUserOrgId).toHaveBeenCalledTimes(2);
  });

  it("exposes only lookup plus the narrow configured-admin bootstrap capability", () => {
    const port = buildPort();

    expect(Object.keys(port)).toEqual([
      "findUserOrgId",
      "ensureConfiguredPlatformAdminOwner",
    ]);
  });
});
