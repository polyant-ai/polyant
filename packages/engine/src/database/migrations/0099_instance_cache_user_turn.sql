-- Per-instance opt-in: also cache the current user turn on the first step of a
-- multi-step turn (Anthropic cacheControl / Bedrock cachePoint). Default false
-- keeps the prior requests unchanged.
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "cache_user_turn" boolean DEFAULT false NOT NULL;
