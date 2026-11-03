-- How an agent with tool results in history replays its earlier turns.
--
-- "compact" (the default, and the behaviour before this setting existed) rebuilds
-- each earlier turn from the persisted steps: one assistant message carrying the
-- text and every tool call, one tool message with results truncated to 2000
-- characters. "exact" replays each earlier turn as it was sent to the model, so
-- the request prefix of turn N+1 equals what turn N already sent and the
-- provider's prompt cache can read it.
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "tool_history_replay" text DEFAULT 'compact' NOT NULL;
ALTER TABLE "instances" DROP CONSTRAINT IF EXISTS "instances_tool_history_replay_check";
ALTER TABLE "instances" ADD CONSTRAINT "instances_tool_history_replay_check"
  CHECK ("tool_history_replay" IN ('compact', 'exact'));

-- The messages a row contributed to the model request, as sent, written only for
-- agents on "exact" replay: the user turn with its content parts (the volatile
-- <context> tail included) on a user row, the turn's step-by-step assistant and
-- tool messages on an assistant row. `json`, not `jsonb`: jsonb reorders object
-- keys, and a tool input or result serialized in a different key order is a
-- different request prefix.
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "exact_replay" json;
