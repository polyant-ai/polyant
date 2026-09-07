// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MeController is a pure HTTP bridge, so these tests pin the two things that
 * silently brick the admin panel when they regress:
 *
 * 1. `GET /api/me` declares ORG_READ. Without it, `PermissionGuard` denies the
 *    route under `AUTHZ_ENFORCE=true` and every tenant-scoped page loses the
 *    tenancy it needs to build its own URL.
 * 2. `POST /api/me/password` declares `@AuthenticatedOnly()`. Without it the
 *    same deny-by-default rule bricks the forced-password-change flow — and
 *    with a permission instead, a service principal could rotate a user's
 *    credentials.
 *
 * The route-authorization guardrail covers the whole surface, but it needs the
 * full controller graph (and therefore the plugin SDK) to load — these run
 * standalone.
 */

import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { REQUIRE_PERMISSION_KEY } from "../authz/decorators/require-permission.decorator.js";
import { AUTHENTICATED_ONLY_KEY } from "../authz/decorators/authenticated-only.decorator.js";
import { MeController } from "./me.controller.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";

const actor: AuthenticatedUser = {
  userId: "user-1",
  email: "owner@example.test",
  principalType: "user",
  orgId: "org-1",
};

function metadataOf(key: string, handler: keyof MeController): unknown {
  const proto = MeController.prototype as unknown as Record<string, unknown>;
  return Reflect.getMetadata(key, proto[handler] as object);
}

describe("MeController", () => {
  it("declares authenticated-only on the tenancy route, not a permission", () => {
    expect(metadataOf(AUTHENTICATED_ONLY_KEY, "context")).toBe(true);
    expect(metadataOf(REQUIRE_PERMISSION_KEY, "context")).toBeUndefined();
  });

  it("declares authenticated-only on the password route", () => {
    expect(metadataOf(AUTHENTICATED_ONLY_KEY, "changePassword")).toBe(true);
  });

  it("leaves the password route without a permission — identity is the whole check", () => {
    expect(metadataOf(REQUIRE_PERMISSION_KEY, "changePassword")).toBeUndefined();
  });

  it("keeps tenancy lookup and password rotation as distinct self-service endpoints", async () => {
    const users = { changeOwnPassword: vi.fn().mockResolvedValue(undefined) };
    const context = {
      organization: { slug: "acme", name: "Acme" },
      workspaces: [{ slug: "default", name: "Default", isDefault: true }],
    };
    const tenant = { getContextFor: vi.fn().mockResolvedValue(context) };
    const controller = new MeController(users as never, tenant as never);

    await expect(controller.context(actor)).resolves.toEqual(context);
    expect(tenant.getContextFor).toHaveBeenCalledWith(actor);

    await expect(
      controller.changePassword(actor, {
        currentPassword: "current-password",
        newPassword: "replacement-password",
      }),
    ).resolves.toEqual({ ok: true });
    expect(users.changeOwnPassword).toHaveBeenCalledWith(actor, {
      currentPassword: "current-password",
      newPassword: "replacement-password",
    });
  });
});
