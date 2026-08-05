-- Per-message model + cost + cache metadata on pipeline_traces.
-- pipeline_traces is written once per user turn and already carries the
-- (previously unset) message_id column; populating it links the trace to the
-- persisted assistant message by id instead of fragile ordinal matching, and
-- the new columns let the admin panel show model / input-cache-output cost per
-- message. All nullable: legacy rows simply have no breakdown.
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "cached_input_tokens" integer;
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "cache_creation_input_tokens" integer;
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "model" text;
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "provider" text;
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "cost" jsonb;
-- Lookup by message_id when merging per-message metadata into the messages API.
CREATE INDEX IF NOT EXISTS "idx_traces_message" ON "pipeline_traces" ("message_id");
