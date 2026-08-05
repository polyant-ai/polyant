// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * OSS management-plane write-audit log (RBAC Stream 7).
 *
 * Records the forensic trail of *destructive* management mutations
 * (agent create/delete, secret write/delete, member removal): who did what to
 * which target, and when. One row per mutation.
 *
 * Deliberately distinct from the two other audit surfaces:
 *  - EE `authz_audit_logs` — authorization *read/access* events (EE-only write path).
 *  - AI-runtime `tool_audit_logs` — per-tool-call audit inside the agent pipeline.
 *
 * `actorUserId` / `actorEmail` are nullable: gateway-authenticated modes forward
 * an identity without a local user row, and a few mutation paths may run
 * unauthenticated at the network edge — the action is still worth recording.
 */
export const managementAuditLogs = pgTable(
  "management_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // e.g. 'agent.create', 'agent.delete', 'secret.write', 'secret.delete', 'member.remove'.
    action: varchar("action", { length: 100 }).notNull(),
    actorUserId: uuid("actor_user_id"),
    actorEmail: varchar("actor_email", { length: 255 }),
    targetType: varchar("target_type", { length: 50 }).notNull(),
    // Free-form target identifier (agent slug, secret key, user id) — not an FK
    // so audit rows survive deletion of the target they describe.
    targetId: varchar("target_id", { length: 255 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_management_audit_created").on(t.createdAt),
    index("idx_management_audit_action_created").on(t.action, t.createdAt),
    index("idx_management_audit_actor").on(t.actorUserId),
  ],
);
