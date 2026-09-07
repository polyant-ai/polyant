// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";
import {
  ensureConfiguredPlatformAdminOwner,
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
 *  2. The explicitly configured `PLATFORM_ADMIN_EMAIL`, when it exists, is
 *     promoted and made Owner of that organization in one transaction.
 *  3. The password-seeded initial admin is made Owner too, but is never
 *     promoted here: the store only acts if that account is already privileged.
 *  4. On a fresh install (zero users) there is nothing to backfill — the
 *     migration's user backfill already covered any pre-existing users. This
 *     branch is a deliberate no-op.
 *
 * OAuth users are still not provisioned at boot. The web sign-in callback calls
 * the narrow internal endpoint only for the exact configured platform-admin
 * email, covering the first Google login without granting anyone else access.
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

  const adminEmail = config.auth.platformAdminEmail;
  if (adminEmail) {
    const organizationId = await ensureConfiguredPlatformAdminOwner(adminEmail);
    if (organizationId) {
      console.log(`${LOG_PREFIX} Configured platform admin bootstrap applied.`);
    } else {
      // Intentionally omit the email: boot logs are persisted and configuration
      // values are not runtime diagnostics.
      console.log(`${LOG_PREFIX} Configured platform admin not present yet.`);
    }
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
