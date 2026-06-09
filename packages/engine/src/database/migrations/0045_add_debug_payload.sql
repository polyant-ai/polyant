-- Per-instance DEBUG mode + per-turn LLM request payload capture.
--
-- When `instances.debug_enabled` is on, the engine persists the exact LLM
-- request payload (full system prompt, the messages array sent to the model,
-- and the tool definitions) into `conversation_messages.debug_payload` for each
-- assistant turn, for analysis/debug. Default false: this is heavy and stores
-- PII at rest. The column is never selected by the default message-list query;
-- it is fetched on-demand via the per-message debug endpoint.

ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "debug_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "debug_payload" jsonb;
