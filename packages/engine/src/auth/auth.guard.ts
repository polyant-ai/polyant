// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./decorators/public.decorator.js";
import { ALLOW_INSTANCE_API_KEY } from "./decorators/allow-instance-api-key.decorator.js";
import { validateSessionToken } from "./auth-user.service.js";
import { findInstanceByAuthApiKey } from "../instances/secrets.store.js";
import { validateManagementApiKey } from "./management-api-keys.store.js";

const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

/** Header carrying a management API key for non-human (service) callers. */
const MANAGEMENT_API_KEY_HEADER = "x-polyant-key";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.flag(context, IS_PUBLIC_KEY)) return true;

    const request = context.switchToHttp().getRequest();

    // Management API key: a non-human caller (CI, cron, SaaS connector) presents
    // the X-Polyant-Key header instead of an OAuth session. Checked before the
    // session/gateway branches because a machine principal carries no JWT.
    const managementKey = request.headers[MANAGEMENT_API_KEY_HEADER];
    if (managementKey) {
      const principal = await validateManagementApiKey(managementKey);
      if (!principal) {
        throw new UnauthorizedException("Invalid management API key");
      }
      request.user = principal;
      return true;
    }

    // Session mode: Auth.js JWT from cookie or Bearer, with per-instance API key fallback.
    const { token, cookieName } = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException("Missing authentication");
    }

    const user = await validateSessionToken(token, cookieName);
    if (user) {
      request.user = { ...user, source: "session" };
      return true;
    }

    // Session validation failed — if the route allows per-instance API keys,
    // try matching the bearer token against the AUTH_API_KEY secrets.
    if (this.flag(context, ALLOW_INSTANCE_API_KEY)) {
      const principal = await findInstanceByAuthApiKey(token);
      if (principal) {
        request.user = {
          kind: "instance",
          instanceSlug: principal.slug,
          instanceId: principal.instanceId,
        };
        return true;
      }
    }

    throw new UnauthorizedException("Invalid or expired session");
  }

  /** Whether the handler or its controller carries the boolean decorator `key`. */
  private flag(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  private extractToken(request: {
    headers: Record<string, string | undefined>;
    cookies?: Record<string, string>;
  }): { token: string | null; cookieName?: string } {
    const authHeader = request.headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
      return { token: authHeader.slice(7) };
    }

    const cookies = request.cookies ?? {};
    for (const name of SESSION_COOKIE_NAMES) {
      if (cookies[name]) return { token: cookies[name], cookieName: name };
    }

    return { token: null };
  }
}
