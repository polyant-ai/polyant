// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";
import { hashPassword } from "./password.util.js";
import { countUsers, insertUser } from "./users.store.js";

/**
 * Idempotent: on first boot (users table empty) creates a `superadmin` account
 * using the password supplied via INITIAL_ADMIN_PASSWORD. If the env var is
 * absent, seeding is skipped with a loud warning — we never auto-generate and
 * print credentials, because the boot logs are tee'd to engine-YYYY-MM-DD.log
 * by file-logger.ts and any secret written there is effectively persisted.
 *
 * Subsequent boots are no-ops — never overwrites existing users.
 */
export async function seedInitialAdmin(): Promise<void> {
  const existing = await countUsers();
  if (existing > 0) {
    console.log(`[users/seed] Skipped — ${existing} user(s) already exist`);
    return;
  }

  const password = config.initialAdmin.password;
  if (!password) {
    console.warn(
      "[users/seed] Skipping initial admin seed: INITIAL_ADMIN_PASSWORD is not set. " +
        "Set INITIAL_ADMIN_PASSWORD (and optionally INITIAL_ADMIN_EMAIL) in the environment and restart.",
    );
    return;
  }

  const email = config.initialAdmin.email ?? "administrator@local";
  const passwordHash = await hashPassword(password);

  await insertUser({
    email,
    name: "administrator",
    passwordHash,
    role: "superadmin",
    mustChangePassword: true,
  });

  // Confirm seeding with the email only — never the password.
  console.log(
    `[users/seed] Seeded admin "${email}" with provided password (INITIAL_ADMIN_PASSWORD)`,
  );
}
