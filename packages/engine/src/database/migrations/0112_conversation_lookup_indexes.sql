-- Deleting a conversation removes its traces and the memories extracted from it,
-- and opening one reads its traces: none of the two columns had an index, so each
-- of those statements scanned the whole table of the deployment.
--
-- Built concurrently, outside a transaction, so both tables keep taking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_traces_conversation" ON "pipeline_traces" ("conversation_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_memories_source_conv" ON "memories" ("source_conversation_id");
