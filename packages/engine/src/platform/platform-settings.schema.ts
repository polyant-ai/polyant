// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, boolean, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../auth/users.schema.js";

/**
 * The installation's own policies — the tier that had no table.
 *
 * ONE row, and the primary key is what enforces it: `id` is a boolean that may
 * only be true, so a second row is a constraint violation rather than a silent
 * second opinion about the same policy. The row is seeded by the migration with
 * both values unset, so a reader never has to tell "no row yet" from "row with
 * NULLs" — two shapes for one question.
 *
 * NULL means "not set here" and falls back to the shipped default in
 * `platform-settings.store.ts`. `updatedBy` is nullable because a user may be
 * deleted after setting a policy; the management audit trail is what survives.
 */
export const platformSettings = pgTable("platform_settings", {
  id: boolean("id").primaryKey().default(true),
  /**
   * How many days of `ai_logs` and `pipeline_traces` the daily housekeeping
   * keeps. Policy, not capacity — and the one value here whose wrong setting
   * destroys data, which is why the route that writes it is audited.
   */
  analyticsRetentionDays: integer("analytics_retention_days"),
  /** Concurrent activity-stream subscribers ONE authenticated user may hold. */
  sseMaxConnectionsPerUser: integer("sse_max_connections_per_user"),
  /** Concurrent activity-stream subscribers the whole process may hold. */
  sseMaxConnections: integer("sse_max_connections"),
  /**
   * The engine's public origin — how an external producer must address it, and
   * therefore what every webhook URL, OAuth redirect and agent card is built
   * from. `BASE_URL` remains the bootstrap value, because the engine has to be
   * able to name itself before anyone opens the panel; this column is how a
   * wrong public URL is corrected without a redeploy.
   *
   * It cannot be derived from the request that asks for it: the panel reaches
   * the engine through its own rewrite, so the host on that request is the
   * internal one. And a redirect URI that varied per request would never match
   * the one registered with the provider.
   */
  baseUrl: text("base_url"),
  /**
   * The global rate limit: window and requests per window. Per-route `@Throttle`
   * overrides keep their own numbers — they are properties of the route, not of
   * the installation. Turning throttling OFF stays an environment variable
   * (`THROTTLE_ENABLED`), because it exists for parallel local runs rather than
   * for an operator, and because a policy that can disable itself from inside
   * the product is one a locked-out administrator cannot use.
   */
  throttleTtlMs: integer("throttle_ttl_ms"),
  throttleLimit: integer("throttle_limit"),
  /** Wall-clock budget of one agent-to-agent invocation. */
  agentCallTimeoutMs: integer("agent_call_timeout_ms"),
  /** Budget of one MCP server's connect + list-tools round trip. */
  mcpConnectTimeoutMs: integer("mcp_connect_timeout_ms"),
  /**
   * Scheduler crash safety: how old a `running` row must be before it is assumed
   * orphaned, and the deadline for a run whose task declares none. Both are
   * judgements about how long a deploy takes and how long a task may legitimately
   * run — properties of THIS installation, which is why they stopped being
   * properties of the image.
   */
  schedulerOrphanGraceMs: integer("scheduler_orphan_grace_ms"),
  schedulerDefaultMaxRunMs: integer("scheduler_default_max_run_ms"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});
