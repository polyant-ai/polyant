// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { config } from "../config.js";
import { IS_PUBLIC_KEY } from "./decorators/public.decorator.js";
import { ALLOW_INSTANCE_API_KEY } from "./decorators/allow-instance-api-key.decorator.js";
import { validateSessionToken } from "./auth-user.service.js";
import { findInstanceByAuthApiKey } from "../instances/secrets.store.js";
import { validateManagementApiKey } from "./management-api-keys.store.js";
import { parseAlbOidcData } from "./alb-oidc.service.js";
import type { AuthenticatedUser } from "./auth.types.js";

const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

const ALB_OIDC_HEADER = "x-amzn-oidc-data";

/** Header carrying a management API key for non-human (service) callers. */
const MANAGEMENT_API_KEY_HEADER = "x-polyant-key";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

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

    // Gateway-authenticated mode: trust the cloud auth gateway's identity header.
    // ECS security group must restrict ingress to the ALB SG so the header can't be spoofed.
    if (config.auth.mode === "alb-oidc") {
      const user = this.authenticateViaAlb(request);
      if (!user) {
        throw new UnauthorizedException("Missing ALB OIDC identity");
      }
      request.user = user;
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
    const allowsInstanceKey = this.reflector.getAllAndOverride<boolean>(
      ALLOW_INSTANCE_API_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowsInstanceKey) {
      const principal = await findInstanceByAuthApiKey(token);
      if (principal) {
        request.user = {
          kind: "instance",
          instanceSlug: principal.slug,
          agentId: principal.agentId,
        };
        return true;
      }
    }

    throw new UnauthorizedException("Invalid or expired session");
  }

  /**
   * Trust ALB OIDC headers. Assumes ALB has already authenticated the request
   * and only traffic routed through the ALB can reach this service (enforced
   * via ECS security group).
   */
  private authenticateViaAlb(request: {
    headers: Record<string, string | undefined>;
  }): AuthenticatedUser | null {
    const header = request.headers[ALB_OIDC_HEADER];
    if (!header) return null;
    return parseAlbOidcData(header);
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
