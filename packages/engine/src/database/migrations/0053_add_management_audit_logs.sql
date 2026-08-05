-- RBAC Stream 7 — OSS management write-audit log.
--
-- Creates `management_audit_logs`: the forensic trail of *destructive*
-- management mutations (agent create/delete, secret write/delete, member
-- removal) recording actor + target + action. Distinct from the EE
-- `authz_audit_logs` (authorization read/access) and the AI-runtime
-- `tool_audit_logs` (per-tool-call pipeline audit).
--
-- Idempotent (IF NOT EXISTS) so re-running is a no-op. Audit rows are
-- intentionally FK-free on the target so they survive deletion of the agent /
-- secret / member they describe.

CREATE TABLE IF NOT EXISTS "management_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "action" varchar(100) NOT NULL,
  "actor_user_id" uuid,
  "actor_email" varchar(255),
  "target_type" varchar(50) NOT NULL,
  "target_id" varchar(255) NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_management_audit_created" ON "management_audit_logs" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_management_audit_action_created" ON "management_audit_logs" ("action","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_management_audit_actor" ON "management_audit_logs" ("actor_user_id");
