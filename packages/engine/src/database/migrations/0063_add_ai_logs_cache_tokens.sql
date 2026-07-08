-- Prompt-cache token accounting on ai_logs.
-- Captures the cache-read / cache-write breakdown the AI SDK exposes so
-- Analytics can compute cache hit-rate and real (cache-adjusted) cost.
-- Both are a subset of prompt_tokens; 0 when prompt caching is off/unsupported.
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "cached_input_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "cache_creation_input_tokens" integer NOT NULL DEFAULT 0;
