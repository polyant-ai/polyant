-- Re-apply the conversation-list performance indexes as a trailing migration.
--
-- These indexes were first introduced by 0055_conversation_list_indexes (OSS) /
-- 0058_conversation_list_indexes (enterprise). On enterprise the migration was
-- renumbered on merge but kept the original OSS `when` (1780444800000), which is
-- BELOW the enterprise-only 0056/0057 timestamps — so drizzle's "apply only when
-- `when` > max(created_at)" rule silently SKIPS it forever (the journal footgun in
-- CLAUDE.md). Without them the conversation-list LATERAL token/cost aggregation
-- seq-scans the whole ai_logs table once per conversation (~57s on a real dataset).
--
-- This trailing migration carries a `when` above every prior entry on BOTH branches,
-- so it applies on already-migrated databases regardless of the skip history. It is
-- idempotent (IF NOT EXISTS), so on OSS — where 0055 already created the indexes — it
-- is a harmless no-op, keeping the migration lineage aligned across branches.
--
-- ponytail: plain CREATE INDEX locks writes while building. Both target tables are
-- small (ai_logs, conversations); on a very large deployment run these manually with
-- CREATE INDEX CONCURRENTLY (cannot run inside the migration transaction).

CREATE INDEX IF NOT EXISTS "idx_ai_logs_conversation_id" ON "ai_logs" ("conversation_id");
CREATE INDEX IF NOT EXISTS "idx_conversations_instance_updated" ON "conversations" ("instance_id", "updated_at");
