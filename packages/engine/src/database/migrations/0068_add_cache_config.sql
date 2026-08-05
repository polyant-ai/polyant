-- Per-instance prompt-cache control. `cache_enabled` toggles all cache markers
-- (Anthropic cacheControl / Bedrock cachePoint) on/off; `cache_ttl` selects the
-- cross-turn Anthropic breakpoint TTL ("5m" | "1h"). Defaults preserve prior
-- behaviour (caching on, 1h). No effect on OpenAI (automatic) or Nebius (no cache).
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "cache_enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "cache_ttl" text NOT NULL DEFAULT '1h';
