// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { TtlCache } from "../utils/ttl-cache.js";
import { users } from "./users.schema.js";

/**
 * Whether an account still has to replace its password — read from the
 * database, per request, never from a token claim.
 *
 * The panel locks a user with `must_change_password` onto `/password-change`
 * using the `mustChangePassword` claim of their session. That claim is only a
 * redirect: the engine used to read the flag nowhere, so the same session could
 * drive the whole API (or clear the claim with one `useSession().update()` POST)
 * and a temporary password an admin handed out stayed usable forever. The flag
 * is therefore enforced where the engine authenticates, from the users table, as
 * `is_platform_admin` is.
 *
 * Only a `false` answer is cached. A pending account makes few requests (it is
 * held on one screen), so asking the database every time costs nothing, and the
 * moment the password changes the very next request — on any process — sees the
 * new value. A cached `false` is dropped by `invalidatePasswordChangePending`
 * when an admin resets the password, and otherwise expires within the TTL.
 */
const notPending = new TtlCache<string, true>({ maxSize: 10_000, ttlMs: 30_000 });

export async function passwordChangePending(userId: string): Promise<boolean> {
  if (notPending.get(userId)) return false;
  const [row] = await db
    .select({ mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const pending = row?.mustChangePassword === true;
  if (!pending) notPending.set(userId, true);
  return pending;
}

/** Forget a user's cached answer — called after every write to the flag. */
export function invalidatePasswordChangePending(userId: string): void {
  notPending.delete(userId);
}
