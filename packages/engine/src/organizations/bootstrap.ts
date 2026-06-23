// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";
import {
  findDefaultOrganization,
  promotePlatformAdminByEmail,
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
 *  2. If `PLATFORM_ADMIN_EMAIL` is configured, promotes that user to Platform
 *     Superadmin (idempotent UPDATE; no-op when the email is unknown).
 *  3. On a fresh install (zero users) there is nothing to backfill — the
 *     migration's user backfill already covered any pre-existing users. This
 *     branch is a deliberate no-op.
 *
 * NOTE: users created AFTER this migration (OAuth sign-in, the users API, the
 * initial-admin seed) are NOT yet auto-provisioned into the default org. The
 * helpers exist (ensureDefaultMembership / ensureOwnerBinding) but stay unwired
 * until the membership stream defines the default-role policy — wiring them now
 * would grant every new user Owner. Tracked in #109 (RBAC Stream 6).
 *
 * Never throws into the boot sequence: failures are logged and swallowed by the
 * caller, exactly like the existing superadmin seed.
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
    // Log the outcome only — never the configured email. Boot logs are tee'd to
    // engine-YYYY-MM-DD.log by file-logger.ts, so an email here is PII at rest.
    const promoted = await promotePlatformAdminByEmail(adminEmail);
    if (promoted > 0) {
      console.log(`${LOG_PREFIX} Promoted the configured PLATFORM_ADMIN_EMAIL to Platform Superadmin.`);
    } else {
      console.log(
        `${LOG_PREFIX} PLATFORM_ADMIN_EMAIL set but no matching user yet — will apply once they sign in.`,
      );
    }
  }

  const userCount = await countUsers();
  if (userCount === 0) {
    console.log(`${LOG_PREFIX} Fresh install (0 users) — nothing to backfill.`);
    return;
  }

  // Count is not logged — it leaks deployment size into the tee'd boot log.
  console.log(`${LOG_PREFIX} Ready — default org present.`);
}
