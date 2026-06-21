// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { OssEntitlementService } from "./entitlement.service.js";

describe("OssEntitlementService", () => {
  it("reports every feature as unavailable in OSS builds", () => {
    const svc = new OssEntitlementService();
    expect(svc.isAvailable("custom-roles")).toBe(false);
    expect(svc.isAvailable("anything-else")).toBe(false);
  });
});
