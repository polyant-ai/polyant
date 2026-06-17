// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";
import {
  countUsers,
  findDefaultOrganization,
  promotePlatformAdminByEmail,
} from "./organizations.store.js";

const LOG_PREFIX = "[organizations/bootstrap]";

/**
 * First-boot RBAC bootstrap (design §8). Runs on every boot and is fully
 * idempotent:
 *
 *  1. Verifies the default organization exists (created by migration 0050).
 *     If it is missing the migration has not run — log and stop, never create
 *     tenancy rows here (the migration owns the seed + backfill).
 *  2. If `PLATFORM_ADMIN_EMAIL` is configured, promotes that user to Platform
 *     Superadmin (idempotent UPDATE; no-op when the email is unknown).
 *  3. On a fresh install (zero users) there is nothing to backfill — the
 *     migration's user backfill already covered any pre-existing users, and new
 *     users are provisioned at sign-in time. This branch is a deliberate no-op.
 *
 * Never throws into the boot sequence: failures are logged and swallowed by the
 * caller, exactly like the existing superadmin seed.
 */
export async function bootstrapOrganizations(): Promise<void> {
  const defaultOrg = await findDefaultOrganization();
  if (!defaultOrg) {
    console.warn(
      `${LOG_PREFIX} Default organization not found — run migrations (0050) before boot. Skipping bootstrap.`,
    );
    return;
  }

  const adminEmail = config.auth.platformAdminEmail;
  if (adminEmail) {
    const promoted = await promotePlatformAdminByEmail(adminEmail);
    if (promoted > 0) {
      console.log(`${LOG_PREFIX} Promoted "${adminEmail}" to Platform Superadmin.`);
    } else {
      console.log(
        `${LOG_PREFIX} PLATFORM_ADMIN_EMAIL set but no user "${adminEmail}" yet — will apply once they sign in.`,
      );
    }
  }

  const userCount = await countUsers();
  if (userCount === 0) {
    console.log(`${LOG_PREFIX} Fresh install (0 users) — nothing to backfill.`);
    return;
  }

  console.log(`${LOG_PREFIX} Ready — default org present, ${userCount} user(s).`);
}
