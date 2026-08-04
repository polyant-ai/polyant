// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sign-in org resolution is a LOOKUP, and these tests exist mostly to keep it
 * one.
 *
 * It used to provision: a user with no membership got the default-org membership
 * plus the OWNER binding, so passing the sign-in domain allowlist made you an
 * Owner of the organization. On a deployment whose allowlist is a company domain,
 * that was every employee. Membership is now granted deliberately through
 * `PUT /api/organizations/:orgSlug/members/:userId`.
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

    await expect(resolveSignInOrgId(port, "user-1")).resolves.toBe("org-existing");
  });

  it("returns null for a user with no membership, and provisions nothing", async () => {
    const port = buildPort({ findUserOrgId: vi.fn(async () => null) });

    await expect(resolveSignInOrgId(port, "user-1")).resolves.toBeNull();
    // The whole point: no membership is a valid answer, not a condition to fix by
    // granting one. `null` reaches the engine as `organization: null` and the
    // panel tells the user to ask an administrator.
    expect(port.findUserOrgId).toHaveBeenCalledWith("user-1");
  });

  /**
   * A structural guard rather than a behaviour test. The port is the ONLY way this
   * module can touch the database, so an empty write surface is what makes
   * "sign-in cannot grant membership" true by construction instead of by review.
   * Re-adding a write capability here should require deleting this test on
   * purpose.
   */
  it("exposes no write capability at all", () => {
    const port = buildPort();

    expect(Object.keys(port)).toEqual(["findUserOrgId"]);
  });
});
