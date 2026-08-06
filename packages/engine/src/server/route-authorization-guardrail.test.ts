// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every route handler the server mounts must declare how it is authorized.
 *
 * This guardrail used to walk a hand-maintained `ALL_CONTROLLERS` array that
 * called itself "the authoritative list of every controller registered". It
 * had drifted: it covered 29 of the 34 mounted controllers, and every
 * undeclared route in the codebase lived in one of the five it did not import
 * — so the test was green while `/api/users/*` and a duplicate, undecorated
 * skills controller were reachable with no authorization declaration at all.
 *
 * The list is now DERIVED from the NestJS module graph, the same metadata Nest
 * itself reads when it binds routes. A controller cannot be mounted without
 * appearing here, so the guardrail can no longer fall out of date.
 */

import { describe, expect, it } from "vitest";
import {
  PATH_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
} from "@nestjs/common/constants";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator.js";
import { REQUIRED_ROLES_KEY } from "../auth/decorators/require-role.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../authz/decorators/require-permission.decorator.js";
import { AUTHENTICATED_ONLY_KEY } from "../authz/decorators/authenticated-only.decorator.js";
import { ServerModule } from "./server.module.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ControllerClass = new (...args: any[]) => object;
type ModuleRef =
  | ControllerClass
  | { module?: unknown; imports?: unknown[]; controllers?: unknown[] };

interface RouteHandler {
  readonly controller: ControllerClass;
  readonly handler: string;
}

function describeHandler({ controller, handler }: RouteHandler): string {
  return `${controller.name}.${handler}`;
}

/**
 * Depth-first walk of the module graph collecting every registered controller.
 * Handles both static modules (metadata on the class) and dynamic ones
 * (`ThrottlerModule.forRoot(...)` and friends return a plain object carrying
 * the same keys), exactly as the NestJS module scanner does.
 */
function collectControllers(
  entry: ModuleRef | undefined,
  seen = new Set<unknown>(),
  found = new Set<ControllerClass>(),
): Set<ControllerClass> {
  if (!entry || seen.has(entry)) return found;
  seen.add(entry);

  const dynamic = typeof entry === "object" ? entry : undefined;
  const target = (dynamic?.module ?? entry) as object;

  const controllers = [
    ...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, target) as ControllerClass[]) ?? []),
    ...((dynamic?.controllers as ControllerClass[]) ?? []),
  ];
  for (const controller of controllers) found.add(controller);

  const imports = [
    ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, target) as ModuleRef[]) ?? []),
    ...((dynamic?.imports as ModuleRef[]) ?? []),
  ];
  for (const imported of imports) collectControllers(imported, seen, found);

  return found;
}

/**
 * A method is an HTTP route handler when the routing decorators (`@Get`,
 * `@Post`, ...) have stamped both the path and the HTTP method metadata onto
 * it — that is the same signal NestJS uses to bind a route.
 */
function isRouteHandler(target: object): boolean {
  return (
    Reflect.hasMetadata(PATH_METADATA, target) &&
    Reflect.hasMetadata(METHOD_METADATA, target)
  );
}

function collectRouteHandlers(controller: ControllerClass): RouteHandler[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .filter((name) => typeof prototype[name] === "function")
    .filter((name) => isRouteHandler(prototype[name] as object))
    .map((name) => ({ controller, handler: name }));
}

/** Reads metadata from the handler first, then the controller class. */
function readMetadata(
  controller: ControllerClass,
  handler: string,
  key: string,
): unknown {
  const prototype = controller.prototype as Record<string, unknown>;
  const handlerValue = Reflect.getMetadata(key, prototype[handler] as object);
  if (handlerValue !== undefined) return handlerValue;
  return Reflect.getMetadata(key, controller);
}

function isPublic(controller: ControllerClass, handler: string): boolean {
  return readMetadata(controller, handler, IS_PUBLIC_KEY) === true;
}

/**
 * The four decorators PermissionGuard accepts as a declaration. Keep this in
 * step with `PermissionGuard.canActivate` — a decorator the guard honours but
 * this test does not will make correct routes fail the guardrail, and the
 * tempting fix (an allowlist) is exactly what reopens the hole.
 */
function declaresAuthorization(
  controller: ControllerClass,
  handler: string,
): boolean {
  if (isPublic(controller, handler)) return true;
  if (readMetadata(controller, handler, REQUIRE_PERMISSION_KEY) !== undefined) return true;
  if (readMetadata(controller, handler, AUTHENTICATED_ONLY_KEY) === true) return true;
  // @RequireRole defers the decision to RoleGuard — but only a NON-EMPTY list
  // decides anything; RoleGuard short-circuits to allow on an empty one.
  const roles = readMetadata(controller, handler, REQUIRED_ROLES_KEY);
  return Array.isArray(roles) && roles.length > 0;
}

/** `GET /api/foo/:id`, normalised so two registrations of it compare equal. */
function routeKey(controller: ControllerClass, handler: string): string {
  const prototype = controller.prototype as Record<string, unknown>;
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
  const path = String(Reflect.getMetadata(PATH_METADATA, prototype[handler] as object) ?? "");
  const method = String(Reflect.getMetadata(METHOD_METADATA, prototype[handler] as object));
  return `${method} /${base}/${path}`.replace(/\/+/g, "/").replace(/\/$/, "");
}

describe("route authorization guardrail", () => {
  const controllers = [...collectControllers(ServerModule)];
  const handlers = controllers.flatMap((controller) => collectRouteHandlers(controller));

  it("should_discover_controllers_from_the_module_graph", () => {
    // Non-vacuity: a broken walk would silently make every assertion below
    // pass. The floors are deliberately far under the real counts so ordinary
    // additions and removals do not churn this test.
    expect(controllers.length).toBeGreaterThan(20);
    expect(handlers.length).toBeGreaterThan(80);
  });

  it("should_declare_authorization_on_every_handler", () => {
    const undeclared = handlers
      .filter(({ controller, handler }) => !declaresAuthorization(controller, handler))
      .map(describeHandler);

    expect(undeclared).toEqual([]);
  });

  it("should_not_declare_both_public_and_required_permission", () => {
    const conflicting = handlers
      .filter(
        ({ controller, handler }) =>
          isPublic(controller, handler) &&
          readMetadata(controller, handler, REQUIRE_PERMISSION_KEY) !== undefined,
      )
      .map(describeHandler);

    expect(conflicting).toEqual([]);
  });

  it("should_not_mount_two_controllers_on_the_same_route", () => {
    // A duplicate registration silently shadows one of the two, and the loser
    // may be the decorated one. That is how an undecorated copy of
    // `api/agents/:slug/skills` shipped alongside the RBAC-gated original.
    const owners = new Map<string, string[]>();
    for (const { controller, handler } of handlers) {
      const key = routeKey(controller, handler);
      owners.set(key, [...(owners.get(key) ?? []), describeHandler({ controller, handler })]);
    }
    const duplicated = [...owners.entries()].filter(([, list]) => list.length > 1);

    expect(duplicated).toEqual([]);
  });
});
