// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Docker-specific migration runner.
 * Uses a fixed path for migrations (copied to /app/packages/engine/migrations in Dockerfile).
 *
 * Connection string resolved via the Zod-validated central config (config.ts).
 * Render injects env vars directly into the container; dotenv loading is a no-op there.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { runMigrationsLocked } from "./run-migrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// CLI entry-point: console output below is intentional (no structured logger here).
const sql = postgres(config.postgres.databaseUrl, { max: 1 });
const db = drizzle(sql);

// In Docker, migrations are at /app/packages/engine/migrations
// (relative to dist/database/docker-migrate.js → ../../migrations)
const migrationsFolder = resolve(__dirname, "../../migrations");

console.log(`Running migrations from ${migrationsFolder}...`);

await runMigrationsLocked(sql, db, migrationsFolder);

console.log("Migrations applied successfully.");
await sql.end();
