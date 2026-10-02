// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// .env: first in package root (packages/engine/), then in monorepo root
const packageEnv = resolve(__dirname, ".env");
const monorepoEnv = resolve(__dirname, "../../.env");

if (existsSync(packageEnv)) {
  config({ path: packageEnv, quiet: true });
} else if (existsSync(monorepoEnv)) {
  config({ path: monorepoEnv, quiet: true });
} else {
  config({ quiet: true });
}

/*
  Migrations in this repository are written by hand: there are no drizzle-kit
  snapshots under migrations/meta, and most CHECK constraints (on instances,
  organizations and platform_settings), some partial indexes and every data
  backfill live only in the SQL files, not in the Drizzle schema. So
  `drizzle-kit push` is NOT a supported path: diffing these schema files against
  a migrated database would drop what they do not declare. Apply schema changes
  with `npm run db:migrate`.

  The list below still has to name every file that declares a table, so tools
  that read it (`db:studio`) see the whole database. A guardrail test
  (src/database/drizzle-config.guardrail.test.ts) holds it to the source tree.
*/
export default defineConfig({
  out: "./src/database/migrations",
  schema: [
    "./src/ai-gateway/logger.ts",
    "./src/conversations/schema.ts",
    "./src/instances/schema.ts",
    "./src/instances/skill-env.schema.ts",
    "./src/instances/secrets.schema.ts",
    "./src/instances/channels.schema.ts",
    "./src/memory/schema.ts",
    "./src/knowledge/schema.ts",
    "./src/scheduled-tasks/schema.ts",
    "./src/instances/prompts.schema.ts",
    "./src/agents/tools/tools.schema.ts",
    "./src/skills/schema.ts",
    "./src/instances/instance-tools.schema.ts",
    "./src/instances/instance-skills.schema.ts",
    "./src/room/room.schema.ts",
    "./src/audit/audit.schema.ts",
    "./src/auth/users.schema.ts",
    "./src/webhooks/webhooks.schema.ts",
    "./src/analytics/traces.schema.ts",
    "./src/optout/optout.schema.ts",
    "./src/organizations/organization.schema.ts",
    "./src/authz/role.schema.ts",
    "./src/authz/role-binding.schema.ts",
    "./src/authz/authz-audit-log.schema.ts",
    "./src/auth/management-api-keys.schema.ts",
    "./src/conversations/principal-secrets.schema.ts",
    "./src/hooks/hooks.schema.ts",
    "./src/instances/mcp-servers.schema.ts",
    "./src/management-audit/management-audit.schema.ts",
    "./src/platform/platform-settings.schema.ts",
    "./src/server/oauth/oauth-states.schema.ts",
  ],
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ??
      `postgresql://${process.env.POSTGRES_USER ?? "polyant"}:${process.env.POSTGRES_PASSWORD ?? ""}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "polyant"}`,
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : false,
  },
});
