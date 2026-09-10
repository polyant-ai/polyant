// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sign-in org resolution is a LOOKUP, for everyone, with no exception left.
 *
 * It used to provision: a user with no membership got the default-org membership
 * plus the OWNER binding, so passing the sign-in domain allowlist made you an
 * Owner of the organization. On a deployment whose allowlist was a company
 * domain, that was every employee. It then kept one narrow exception for the
 * address configured as `PLATFORM_ADMIN_EMAIL`, which existed because a
 * federated identity could first appear after the boot that would have promoted
 * it — a case that cannot arise without a federated provider.
 *
 * The last test is the one that matters most: the port exposes a single READ,
 * so re-adding a write here means deleting that assertion on purpose.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveSignInOrgId, type OrgProvisioningPort } from "./org-provisioning";

function buildPort(overrides: Partial<OrgProvisioningPort> = {}): OrgProvisioningPort {
  return {
    findUserOrgId: vi.fn(async () => "org-default"),
    ...overrides,
  };
}

describe("resolveSignInOrgId", () => {
  it("returns the user's existing org membership", async () => {
    const port = buildPort({ findUserOrgId: vi.fn(async () => "org-existing") });

    await expect(resolveSignInOrgId(port, { userId: "user-1" })).resolves.toBe(
      "org-existing",
    );
    expect(port.findUserOrgId).toHaveBeenCalledWith("user-1");
  });

  it("returns null for a user with no membership, and provisions nothing", async () => {
    const port = buildPort({ findUserOrgId: vi.fn(async () => null) });

    await expect(resolveSignInOrgId(port, { userId: "user-1" })).resolves.toBeNull();
    // The whole point: no membership is a valid answer, not a condition to fix by
    // granting one. `null` reaches the engine as `organization: null` and the
    // panel tells the user to ask an administrator.
    expect(port.findUserOrgId).toHaveBeenCalledTimes(1);
  });

  it("exposes one read capability and no writes", () => {
    expect(Object.keys(buildPort())).toEqual(["findUserOrgId"]);
  });
});
