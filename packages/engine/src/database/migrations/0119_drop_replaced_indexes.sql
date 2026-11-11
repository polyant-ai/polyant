-- The indexes 0110 and 0111 replaced with wider ones, which serve every query
-- these served. Dropped concurrently, outside a transaction, so the tables stay
-- readable and writable meanwhile.
DROP INDEX CONCURRENTLY IF EXISTS "idx_conversations_instance_updated";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_ai_logs_instance_id";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_conversation_messages_conversation_id";
