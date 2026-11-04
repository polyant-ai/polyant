-- Deleting a conversation removes its traces and the memories extracted from it,
-- and opening one reads its traces: none of the two columns had an index, so each
-- of those statements scanned the whole table of the deployment.
CREATE INDEX IF NOT EXISTS "idx_traces_conversation" ON "pipeline_traces" ("conversation_id");
CREATE INDEX IF NOT EXISTS "idx_memories_source_conv" ON "memories" ("source_conversation_id");
