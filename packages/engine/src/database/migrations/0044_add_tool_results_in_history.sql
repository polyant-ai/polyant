-- Per-instance "replay tool results in cross-turn history" toggle.
--
-- By default the conversation history fed to the model is text-only
-- (getRecentMessages selects role + content), so prior-turn tool_use/tool_result
-- blocks are NOT replayed. When this flag is on, the engine reconstructs them
-- (truncated) from the persisted `steps` so the model retains what tools
-- returned across turns. Default false to avoid the extra per-turn token cost.

ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "tool_results_in_history_enabled" boolean DEFAULT false NOT NULL;
