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
