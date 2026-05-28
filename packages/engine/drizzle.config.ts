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
  config({ path: packageEnv });
} else if (existsSync(monorepoEnv)) {
  config({ path: monorepoEnv });
} else {
  config();
}

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
    "./src/governance/schema.ts",
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
  ],
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ??
      `postgresql://${process.env.POSTGRES_USER ?? "polyant"}:${process.env.POSTGRES_PASSWORD ?? ""}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "polyant"}`,
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : false,
  },
});
