// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Seeds the three RBAC privilege-ladder users (Owner / Member / Viewer) into
 * the test database's default organization, each with a bcrypt password so they
 * can log in through the real credentials form.
 *
 * Assumes migration 0050 has already run (it seeds the default org + the four
 * system roles). Idempotent: each test user is deleted first (FK cascade clears
 * its membership + role binding) then re-created, so re-running yields a clean,
 * deterministic state.
 *
 * Uses raw SQL via postgres-js (resolved from the hoisted root node_modules) to
 * stay decoupled from the engine's Drizzle layer — the harness only needs the
 * row shapes, not the application code.
 */

import bcrypt from "bcryptjs";
import postgres from "postgres";
import { RBAC_TEST_USERS, TEST_DATABASE_URL } from "./test-env.js";

/** Matches engine password.util.ts (bcrypt cost 12). */
const BCRYPT_COST = 12;

export async function seedRbacUsers(connectionUrl: string = TEST_DATABASE_URL): Promise<void> {
  const sql = postgres(connectionUrl, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`
      SELECT id FROM organizations WHERE is_default = true LIMIT 1
    `;
    if (!org) {
      throw new Error(
        "Default organization not found — run migrations (migration 0050) before seeding.",
      );
    }

    for (const user of RBAC_TEST_USERS) {
      const [role] = await sql<{ id: string }[]>`
        SELECT id FROM roles WHERE key = ${user.roleKey} AND organization_id IS NULL LIMIT 1
      `;
      if (!role) {
        throw new Error(`System role "${user.roleKey}" not found — migration seed missing.`);
      }

      const passwordHash = await bcrypt.hash(user.password, BCRYPT_COST);

      await sql.begin(async (tx) => {
        // Cascade removes any prior membership + role binding for this email.
        await tx`DELETE FROM users WHERE email = ${user.email}`;

        const [row] = await tx<{ id: string }[]>`
          INSERT INTO users (email, name, password_hash, role, must_change_password)
          VALUES (${user.email}, ${user.name}, ${passwordHash}, 'user', false)
          RETURNING id
        `;

        await tx`
          INSERT INTO organization_memberships (organization_id, user_id)
          VALUES (${org.id}, ${row.id})
          ON CONFLICT DO NOTHING
        `;

        // Org-scoped binding: the scope-integrity trigger requires
        // scope_id = organization_id for scope_type 'organization'.
        await tx`
          INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
          VALUES (${row.id}, ${role.id}, 'organization', ${org.id}, ${org.id})
        `;
      });

      console.log(`[seed-rbac] seeded ${user.email} as ${user.roleKey}`);
    }
  } finally {
    await sql.end();
  }
}

// CLI entry-point: `tsx e2e/setup/seed-rbac.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  seedRbacUsers().then(
    () => process.exit(0),
    (err) => {
      console.error("[seed-rbac] failed:", err);
      process.exit(1);
    },
  );
}
