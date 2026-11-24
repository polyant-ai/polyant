// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which organization a caller without an organization claim acts within. The
 * rest of the agent store is tested against Postgres in
 * `store.integration.test.ts`; this case needs a deployment with exactly one
 * organization, which a shared test database never is.
 */

import { describe, expect, it } from "vitest";
import { resolvePrincipalOrgId } from "./store.js";

/** An executor whose organizations table holds `ids`. */
function deploymentWithOrganizations(ids: string[]) {
  const executor = {
    select: () => ({ from: () => ({ limit: async (n: number) => ids.slice(0, n).map((id) => ({ id })) }) }),
  };
  return executor as unknown as Parameters<typeof resolvePrincipalOrgId>[1];
}

describe("resolvePrincipalOrgId", () => {
  it("takes the caller's own organization claim", async () => {
    expect(await resolvePrincipalOrgId("org-claimed", deploymentWithOrganizations(["org-1", "org-2"]))).toBe("org-claimed");
  });

  it("falls back to the only organization of a single-organization deployment", async () => {
    expect(await resolvePrincipalOrgId(undefined, deploymentWithOrganizations(["org-only"]))).toBe("org-only");
  });

  it("decides nothing when the caller names none and several organizations exist", async () => {
    expect(await resolvePrincipalOrgId(undefined, deploymentWithOrganizations(["org-1", "org-2", "org-3"]))).toBeNull();
  });
});
