// SPDX-License-Identifier: AGPL-3.0-or-later

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";

const queryClient = postgres(config.postgres.databaseUrl, {
  connection: { TimeZone: "UTC" },
  ssl: config.postgres.ssl ? { rejectUnauthorized: false } : false,
});

export const db = drizzle(queryClient);

export { queryClient };
