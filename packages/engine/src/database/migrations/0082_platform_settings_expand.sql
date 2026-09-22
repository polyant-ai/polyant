-- Eight more deployment variables become policies of the installation.
--
-- Same shape as the two that came before: every column is NULLABLE, NULL means
-- "not set here", and the resolver answers with the shipped default instead. An
-- installation that sets nothing keeps exactly the behaviour it has.
--
-- `base_url` is the one with a second fallback behind it: `BASE_URL` stays as
-- the bootstrap value, because the engine must be able to name itself before
-- anyone has opened the panel. The column wins where it is set, and it is the
-- only way to correct a wrong public URL without a redeploy — which is the
-- failure that matters, since every webhook URL and OAuth redirect is built
-- from it.
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "base_url" text,
  ADD COLUMN IF NOT EXISTS "sse_max_connections" integer,
  ADD COLUMN IF NOT EXISTS "throttle_ttl_ms" integer,
  ADD COLUMN IF NOT EXISTS "throttle_limit" integer,
  ADD COLUMN IF NOT EXISTS "agent_call_timeout_ms" integer,
  ADD COLUMN IF NOT EXISTS "mcp_connect_timeout_ms" integer,
  ADD COLUMN IF NOT EXISTS "scheduler_orphan_grace_ms" integer,
  ADD COLUMN IF NOT EXISTS "scheduler_default_max_run_ms" integer;

-- Zero is not a legitimate value for any of them: a zero window, a zero limit or
-- a zero timeout is not a cautious setting but a broken one, and the difference
-- between "not set" and "set to nothing" is already carried by NULL.
ALTER TABLE "platform_settings"
  ADD CONSTRAINT "platform_settings_positive_limits"
  CHECK (("sse_max_connections" IS NULL OR "sse_max_connections" > 0)
     AND ("throttle_ttl_ms" IS NULL OR "throttle_ttl_ms" > 0)
     AND ("throttle_limit" IS NULL OR "throttle_limit" > 0)
     AND ("agent_call_timeout_ms" IS NULL OR "agent_call_timeout_ms" > 0)
     AND ("mcp_connect_timeout_ms" IS NULL OR "mcp_connect_timeout_ms" > 0)
     AND ("scheduler_orphan_grace_ms" IS NULL OR "scheduler_orphan_grace_ms" > 0)
     AND ("scheduler_default_max_run_ms" IS NULL OR "scheduler_default_max_run_ms" > 0));

-- An origin, not a URL with a path: everything built from it appends its own
-- path, so a trailing slash or a path segment here produces `//webhooks` or a
-- redirect the provider will not match. Refused at the column rather than only
-- in the route, because the route is not the only writer a database outlives.
ALTER TABLE "platform_settings"
  ADD CONSTRAINT "platform_settings_base_url_is_origin"
  CHECK ("base_url" IS NULL OR "base_url" ~ '^https?://[^/?#]+$');
