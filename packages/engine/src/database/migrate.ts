// SPDX-License-Identifier: AGPL-3.0-or-later

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Connection string resolved via the Zod-validated central config (config.ts
// already handles .env loading from package root and monorepo root, and
// derives DATABASE_URL from POSTGRES_* fallbacks when not set explicitly).
//
// `onnotice` swallows PostgreSQL NOTICE-level messages emitted during the run
// (e.g. ~30 lines of "column already exists, skipping" on a fresh DB). The
// final success line below is preserved so the operator still gets a signal.
const sql = postgres(config.postgres.databaseUrl, {
  max: 1,
  // Match the runtime client (client.ts): Aurora/managed Postgres requires SSL
  // (pg_hba rejects unencrypted connections with "no encryption"). Driven by
  // POSTGRES_SSL; rejectUnauthorized:false accepts the managed CA chain.
  ssl: config.postgres.ssl ? { rejectUnauthorized: false } : false,
  onnotice: () => {
    /* swallow NOTICE during migration */
  },
});
const db = drizzle(sql);

const migrationsFolder = resolve(__dirname, "migrations");

// CLI entry-point: console output is intentional (no structured logger here).
console.log(`Running migrations from ${migrationsFolder}...`);

await migrate(db, { migrationsFolder });

console.log("Migrations applied successfully.");
await sql.end();
process.exit(0);
