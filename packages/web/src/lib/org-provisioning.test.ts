// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import {
  resolveSignInOrgId,
  provisionUserDefaultOrg,
  type OrgProvisioningPort,
} from "./org-provisioning";

/** Build a port whose methods are vi.fn()s with sensible defaults overridden per test. */
function buildPort(overrides: Partial<OrgProvisioningPort> = {}): OrgProvisioningPort {
  return {
    findDefaultOrgId: vi.fn(async () => "org-default"),
    findUserOrgId: vi.fn(async () => "org-default"),
    findOwnerRoleId: vi.fn(async () => "role-owner"),
    ensureMembership: vi.fn(async () => undefined),
    ensureOwnerBinding: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("provisionUserDefaultOrg", () => {
  it("ensures membership then Owner binding on the default org", async () => {
    const port = buildPort();

    const orgId = await provisionUserDefaultOrg(port, "user-1");

    expect(orgId).toBe("org-default");
    expect(port.ensureMembership).toHaveBeenCalledWith("org-default", "user-1");
    expect(port.ensureOwnerBinding).toHaveBeenCalledWith(
      "org-default",
      "user-1",
      "role-owner",
    );
  });

  it("skips the Owner binding when no system Owner role exists", async () => {
    const port = buildPort({ findOwnerRoleId: vi.fn(async () => null) });

    const orgId = await provisionUserDefaultOrg(port, "user-1");

    expect(orgId).toBe("org-default");
    expect(port.ensureMembership).toHaveBeenCalledWith("org-default", "user-1");
    expect(port.ensureOwnerBinding).not.toHaveBeenCalled();
  });

  it("returns null and provisions nothing when there is no default org", async () => {
    const port = buildPort({ findDefaultOrgId: vi.fn(async () => null) });

    const orgId = await provisionUserDefaultOrg(port, "user-1");

    expect(orgId).toBeNull();
    expect(port.ensureMembership).not.toHaveBeenCalled();
    expect(port.ensureOwnerBinding).not.toHaveBeenCalled();
  });
});

describe("resolveSignInOrgId", () => {
  it("returns the user's existing org membership when present", async () => {
    const port = buildPort({ findUserOrgId: vi.fn(async () => "org-existing") });

    const orgId = await resolveSignInOrgId(port, "user-1");

    expect(orgId).toBe("org-existing");
    // No provisioning needed when membership already resolves.
    expect(port.ensureMembership).not.toHaveBeenCalled();
  });

  it("provisions the default org when the user has no membership yet (race-safe)", async () => {
    const port = buildPort({
      findUserOrgId: vi.fn(async () => null),
      findDefaultOrgId: vi.fn(async () => "org-default"),
    });

    const orgId = await resolveSignInOrgId(port, "user-1");

    expect(orgId).toBe("org-default");
    expect(port.ensureMembership).toHaveBeenCalledWith("org-default", "user-1");
    expect(port.ensureOwnerBinding).toHaveBeenCalledWith(
      "org-default",
      "user-1",
      "role-owner",
    );
  });

  it("returns null when neither membership nor a default org can be resolved", async () => {
    const port = buildPort({
      findUserOrgId: vi.fn(async () => null),
      findDefaultOrgId: vi.fn(async () => null),
    });

    const orgId = await resolveSignInOrgId(port, "user-1");

    expect(orgId).toBeNull();
  });
});
