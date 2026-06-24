// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Brings the test database to a ready state BEFORE Playwright launches the
 * servers — this is intentionally a pre-step (sequenced via `&&` in the
 * `test:e2e` script) rather than a Playwright globalSetup, because the engine
 * does NOT migrate on boot and would crash connecting to a missing/empty
 * `polyant_e2e`. Running it first sidesteps the webServer/globalSetup ordering.
 *
 * Steps (all idempotent):
 *   1. CREATE DATABASE polyant_e2e (if absent) on the dev PostgreSQL server.
 *   2. Apply the real Drizzle migrations (full schema + default org + roles).
 *   3. Seed the three RBAC test users.
 */

import { execFileSync } from "node:child_process";
import postgres from "postgres";
import {
  ADMIN_DATABASE_URL,
  REPO_ROOT,
  TEST_DATABASE_URL,
  TEST_DB_NAME,
} from "./test-env.js";
import { seedRbacUsers } from "./seed-rbac.js";

async function ensureDatabaseExists(): Promise<void> {
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const existing = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = ${TEST_DB_NAME}
    `;
    if (existing.length === 0) {
      // Identifier can't be parameterized; TEST_DB_NAME is a trusted constant.
      await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      console.log(`[prepare-db] created database ${TEST_DB_NAME}`);
    } else {
      console.log(`[prepare-db] database ${TEST_DB_NAME} already exists`);
    }
  } finally {
    await admin.end();
  }
}

function runMigrations(): void {
  console.log("[prepare-db] applying migrations…");
  execFileSync("npm", ["run", "db:migrate", "-w", "@polyant/engine"], {
    cwd: REPO_ROOT,
    // DATABASE_URL wins over the engine's dotenv (.env never overrides set vars),
    // so migrations land on the test DB regardless of repo-root .env contents.
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, POSTGRES_DB: TEST_DB_NAME },
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  await ensureDatabaseExists();
  runMigrations();
  await seedRbacUsers(TEST_DATABASE_URL);
  console.log("[prepare-db] test database ready.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[prepare-db] failed:", err);
    process.exit(1);
  },
);
