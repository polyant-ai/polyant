// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MeController is a pure HTTP bridge, so these tests pin the two things that
 * silently brick the admin panel when they regress:
 *
 * 1. `GET /api/me` declares ORG_READ. Without it, `PermissionGuard` denies the
 *    route under `AUTHZ_ENFORCE=true` and every tenant-scoped page loses the
 *    tenancy it needs to build its own URL.
 * 2. `POST /api/me/password` declares `@SelfService()`. Without it the same
 *    deny-by-default rule bricks the forced-password-change flow.
 *
 * The route-authorization guardrail covers the whole surface, but it needs the
 * full controller graph (and therefore the plugin SDK) to load — these run
 * standalone.
 */

import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { REQUIRE_PERMISSION_KEY } from "../authz/decorators/require-permission.decorator.js";
import { IS_SELF_SERVICE_KEY } from "../auth/decorators/self-service.decorator.js";
import { Permission } from "../authz/permissions.js";
import { MeController } from "./me.controller.js";

function metadataOf(key: string, handler: keyof MeController): unknown {
  const proto = MeController.prototype as unknown as Record<string, unknown>;
  return Reflect.getMetadata(key, proto[handler] as object);
}

describe("MeController", () => {
  it("declares ORG_READ on the tenancy route", () => {
    expect(metadataOf(REQUIRE_PERMISSION_KEY, "context")).toBe(Permission.ORG_READ);
  });

  it("declares self-service on the password route", () => {
    expect(metadataOf(IS_SELF_SERVICE_KEY, "changePassword")).toBe(true);
  });

  it("leaves the password route without a permission — identity is the whole check", () => {
    expect(metadataOf(REQUIRE_PERMISSION_KEY, "changePassword")).toBeUndefined();
  });

  it("delegates the tenancy route to TenantService with the caller", async () => {
    const tenant = { getContextFor: vi.fn().mockResolvedValue({ organization: null, workspaces: [] }) };
    const controller = new MeController({} as never, tenant as never);
    const actor = { userId: "u1", email: "u@test", principalType: "user" as const };

    await controller.context(actor);

    expect(tenant.getContextFor).toHaveBeenCalledWith(actor);
  });
});
