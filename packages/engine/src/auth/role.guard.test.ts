// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { Reflector } from "@nestjs/core";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { RoleGuard } from "./role.guard.js";
import { REQUIRED_ROLES_KEY } from "./decorators/require-role.decorator.js";

function makeContext(user: unknown, metadata: string[] | undefined): ExecutionContext {
  // Stash the metadata under both handler and class so getAllAndOverride finds it.
  const handler = function handler() {};
  const cls = class Cls {};
  if (metadata) {
    Reflect.defineMetadata(REQUIRED_ROLES_KEY, metadata, handler);
    Reflect.defineMetadata(REQUIRED_ROLES_KEY, metadata, cls);
  }
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe("RoleGuard", () => {
  let guard: RoleGuard;

  beforeEach(() => {
    guard = new RoleGuard(new Reflector());
  });

  it("allows requests on routes with no @RequireRole decorator", () => {
    const ctx = makeContext({ role: "user" }, undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("rejects when request.user is missing despite a role requirement", () => {
    const ctx = makeContext(undefined, ["platform_admin"]);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("allows when the user role matches the required role", () => {
    const ctx = makeContext({ role: "platform_admin" }, ["platform_admin"]);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("allows a normalized platform admin when a legacy decorator requires superadmin", () => {
    // Old deployments can have @RequireRole("superadmin") metadata while
    // AuthGuard normalizes the session claim to the canonical spelling.
    const ctx = makeContext({ role: "platform_admin" }, ["superadmin"]);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("rejects when the user role does not match", () => {
    const ctx = makeContext({ role: "user" }, ["platform_admin"]);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("supports multiple acceptable roles (OR semantics)", () => {
    const ctx1 = makeContext({ role: "user" }, ["platform_admin", "user"]);
    const ctx2 = makeContext({ role: "platform_admin" }, ["platform_admin", "user"]);
    expect(guard.canActivate(ctx1)).toBe(true);
    expect(guard.canActivate(ctx2)).toBe(true);
  });

  it("treats an empty roles array as 'no requirement' (lets it through)", () => {
    const ctx = makeContext({ role: "user" }, []);
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
