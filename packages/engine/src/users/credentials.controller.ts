// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/decorators/public.decorator.js";
import { UsersService } from "./users.service.js";
import { config } from "../config.js";
import { timingSafeEqual } from "crypto";
import { ensureConfiguredPlatformAdminOwner } from "../organizations/organizations.store.js";

/**
 * Endpoint chiamato dal callback `authorize` del provider Credentials di Auth.js
 * web side. Verifies email + password and returns the user record (no hash).
 *
 * Sicurezza:
 * - Public (no JWT) because it's hit during login (the user has no session yet).
 * - Proteggiamo da chiamate esterne con un secret condiviso `AUTH_INTERNAL_SECRET`
 *   in header `x-internal-auth`. Questo secret e' settato nelle env del web e
 *   dell'engine (single source of trust per le chiamate server-to-server).
 * - Rate-limit per IP via @Throttle.
 * - Uniform response on email-not-found and wrong-password (no enumeration).
 */
@Controller("api/auth/credentials")
export class CredentialsController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("verify")
  async verify(
    @Headers("x-internal-auth") internalSecret: string | undefined,
    @Body() body: { email?: string; password?: string },
  ) {
    this.assertInternalSecret(internalSecret);

    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    if (!email || !password) {
      throw new BadRequestException("Email and password are required");
    }

    const user = await this.users.verifyCredentials(email, password);
    return { user };
  }

  /**
   * One-time onboarding path for the identity explicitly configured as
   * PLATFORM_ADMIN_EMAIL. It is intentionally adjacent to credentials verify:
   * both endpoints are callable only by the web server with the internal
   * shared secret, before an Auth.js session exists.
   *
   * This does not accept an arbitrary administrator candidate. The supplied
   * email must equal the server configuration after normalization, then the
   * store atomically grants platform-admin + default-org Owner access.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("bootstrap-owner")
  async bootstrapOwner(
    @Headers("x-internal-auth") internalSecret: string | undefined,
    @Body() body: { email?: unknown } | null | undefined,
  ) {
    this.assertInternalSecret(internalSecret);

    const configuredEmail = config.auth.platformAdminEmail?.trim().toLowerCase();
    if (!body || typeof body.email !== "string" || !body.email.trim()) {
      throw new BadRequestException("Email is required");
    }
    const email = body.email.trim().toLowerCase();
    if (!configuredEmail || email !== configuredEmail) {
      // Avoid confirming whether a particular email is configured.
      throw new UnauthorizedException("Invalid internal bootstrap request");
    }

    const organizationId = await ensureConfiguredPlatformAdminOwner(email);
    return { organizationId };
  }

  private assertInternalSecret(provided: string | undefined): void {
    const expected = config.auth.internalSecret;
    if (!expected) {
      // Configurazione minima: se il secret non e' settato, rifiutiamo per default.
      throw new UnauthorizedException("Internal credentials endpoint disabled");
    }
    if (!provided) throw new UnauthorizedException("Missing internal auth header");

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("Invalid internal auth header");
    }
  }
}
