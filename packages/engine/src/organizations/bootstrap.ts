// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";
import {
  ensureExistingPlatformAdminOwner,
  findDefaultOrganization,
} from "./organizations.store.js";
import { countUsers } from "../users/users.store.js";

const LOG_PREFIX = "[organizations/bootstrap]";

/**
 * First-boot RBAC bootstrap (design §8). Runs on every boot and is fully
 * idempotent:
 *
 *  1. Verifies the default organization exists (created by migration 0051).
 *     If it is missing the migration has not run — log and stop, never create
 *     tenancy rows here (the migration owns the seed + backfill).
 *  2. The password-seeded initial admin is made Owner of that organization, but
 *     is never PROMOTED here: the store only acts if that account is already a
 *     platform admin, which `users/seed.ts` made it when it created the row. So
 *     an arbitrary address matching the configuration can never be elevated.
 *  3. On a fresh install (zero users) there is nothing to backfill — the
 *     migration's user backfill already covered any pre-existing users. This
 *     branch is a deliberate no-op.
 *
 * There is exactly ONE bootstrap identity, and it is the account the seeder
 * created. `PLATFORM_ADMIN_EMAIL` used to name a second one, promoted here at
 * every boot and — for an identity that had not signed in yet — through an
 * internal endpoint the web called during sign-in. Both existed for a federated
 * identity that could appear after boot; with no federated provider left
 * (`web/lib/auth-providers.ts`), an account can only exist because the seeder
 * made it or because an administrator created it, and neither needs a second
 * variable to be recognised.
 *
 * Never throws into the boot sequence: failures are logged and swallowed by the
 * caller, exactly like the existing platform-admin seed.
 */
export async function bootstrapOrganizations(): Promise<void> {
  const defaultOrg = await findDefaultOrganization();
  if (!defaultOrg) {
    console.warn(
      `${LOG_PREFIX} Default organization not found — run migrations (0051) before boot. Skipping bootstrap.`,
    );
    return;
  }

  // This path is gated by the seed password: it identifies a deployment that
  // intentionally created the local initial account. The store additionally
  // verifies the account is already a platform admin, so an arbitrary matching
  // address can never be elevated by this bootstrap.
  if (config.initialAdmin.password) {
    await ensureExistingPlatformAdminOwner(
      config.initialAdmin.email ?? "administrator@local",
    );
  }

  const userCount = await countUsers();
  if (userCount === 0) {
    console.log(`${LOG_PREFIX} Fresh install (0 users) — nothing to backfill.`);
    return;
  }

  // Count is not logged — it leaks deployment size into the tee'd boot log.
  console.log(`${LOG_PREFIX} Ready — default org present.`);
}
