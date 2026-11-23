// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A forced password change against a real database and the real AuthGuard.
 *
 * The error this catches: a user whose `must_change_password` is set reaching
 * the API anyway. The flag used to live only in the panel's redirect, so the
 * session cookie of an account holding an admin-issued temporary password drove
 * every endpoint. Here the guard must refuse an ordinary route, keep open the
 * routes the change needs, open everything once the password is changed, and
 * close again the moment an admin resets it.
 *
 * Routes are the real `MeController` handlers, so the decorators under test are
 * the ones production reads. Self-skips without a migrated database.
 */

import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { hkdf } from "@panva/hkdf";
import { EncryptJWT } from "jose";
import { config } from "../config.js";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { insertUser } from "../users/users.store.js";
import { UsersService } from "../users/users.service.js";
import { MeController } from "../users/me.controller.js";
import { hashPassword } from "../users/password.util.js";
import { AuthGuard } from "./auth.guard.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

const COOKIE = "authjs.session-token";
const EMAIL = "pwgate@example.test";

/** A session cookie as the panel mints it — the claim says nothing is owed. */
async function sessionCookie(userId: string): Promise<string> {
  const key = new Uint8Array(
    await hkdf("sha256", config.auth.secret, COOKIE, `Auth.js Generated Encryption Key (${COOKIE})`, 64),
  );
  return new EncryptJWT({ sub: userId, email: EMAIL, mustChangePassword: false })
    .setProtectedHeader({ alg: "dir", enc: "A256CBC-HS512" })
    .setIssuedAt()
    .encrypt(key);
}

function routeContext(handler: (...args: never[]) => unknown, cookie: string): ExecutionContext {
  const request = { headers: {}, cookies: { [COOKIE]: cookie } };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    getHandler: () => handler,
    getClass: () => MeController,
  } as unknown as ExecutionContext;
}

describe.skipIf(!DB_AVAILABLE)("forced password change at the AuthGuard", () => {
  const guard = new AuthGuard(new Reflector());
  const users = new UsersService();
  const ordinary = MeController.prototype.favoriteAgents;
  const change = MeController.prototype.changePassword;
  const identity = MeController.prototype.context;

  const cleanup = async () => {
    await queryClient`DELETE FROM users WHERE email = ${EMAIL}`;
  };
  beforeEach(cleanup);
  afterEach(cleanup);

  async function plant(mustChangePassword: boolean): Promise<string> {
    const user = await insertUser({
      email: EMAIL,
      passwordHash: await hashPassword("temporary-pass-1"),
      isPlatformAdmin: false,
      mustChangePassword,
    });
    return user.id;
  }

  it("refuses an ordinary route while the password change is owed, whatever the claim says", async () => {
    const cookie = await sessionCookie(await plant(true));

    const refusal = guard.canActivate(routeContext(ordinary, cookie));
    await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: { code: "password_change_required" },
    });
  });

  it("keeps the change route and the identity read open while the change is owed", async () => {
    const cookie = await sessionCookie(await plant(true));

    await expect(guard.canActivate(routeContext(change, cookie))).resolves.toBe(true);
    await expect(guard.canActivate(routeContext(identity, cookie))).resolves.toBe(true);
  });

  it("opens every route once the password is changed, and closes them again on an admin reset", async () => {
    const userId = await plant(true);
    const cookie = await sessionCookie(userId);

    await users.changeOwnPassword({ userId }, { newPassword: "brand-new-pass-2" });
    await expect(guard.canActivate(routeContext(ordinary, cookie))).resolves.toBe(true);

    // The `false` answer above is now cached: the reset must still hold the
    // user from their very next request.
    await users.resetPassword(userId);
    await expect(guard.canActivate(routeContext(ordinary, cookie))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets a user who owes nothing through", async () => {
    const cookie = await sessionCookie(await plant(false));
    await expect(guard.canActivate(routeContext(ordinary, cookie))).resolves.toBe(true);
  });
});
