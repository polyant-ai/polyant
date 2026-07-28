// SPDX-License-Identifier: AGPL-3.0-or-later

import { validateTenantParams } from "./validate";
import type { TenantContextPayload } from "@/lib/api-types";

function makePayload(overrides: Partial<TenantContextPayload> = {}): TenantContextPayload {
  return {
    user: { id: "user-1", email: "owner@example.test", name: "Owner" },
    organization: { slug: "default", name: "Default" },
    workspaces: [
      { slug: "default", name: "Default", isDefault: true },
      { slug: "research", name: "Research", isDefault: false },
    ],
    ...overrides,
  };
}

describe("validateTenantParams", () => {
  it("accepts the caller's own organization", () => {
    expect(validateTenantParams(makePayload(), "default")).toBe(true);
  });

  it("rejects another organization's slug", () => {
    expect(validateTenantParams(makePayload(), "acme")).toBe(false);
  });

  it("accepts any workspace belonging to the organization", () => {
    expect(validateTenantParams(makePayload(), "default", "research")).toBe(true);
  });

  it("rejects a workspace that does not belong to the organization", () => {
    expect(validateTenantParams(makePayload(), "default", "ghost")).toBe(false);
  });

  it("rejects everything when the caller has no organization", () => {
    const payload = makePayload({ organization: null, workspaces: [] });
    expect(validateTenantParams(payload, "default")).toBe(false);
  });

  it("ignores the workspace when none is addressed", () => {
    const payload = makePayload({ workspaces: [] });
    expect(validateTenantParams(payload, "default")).toBe(true);
  });
});
