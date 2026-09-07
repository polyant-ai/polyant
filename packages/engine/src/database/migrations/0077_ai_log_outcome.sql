-- Record WHETHER a provider call returned, not only what it returned.
--
-- Until now a turn that died at the provider (expired key, rate limit, model
-- overloaded) wrote no `ai_logs` row at all: the insert happens after a
-- successful call. So "is this agent failing?" was a question the data could
-- not answer — a systematically broken agent looked identical to an idle one.
--
-- `outcome` defaults to 'ok' so every historical row stays meaningful: they are
-- all, by construction, calls that returned.
--
-- `error_kind` holds the CLASS of the failure (auth / rate_limit / bad_request /
-- overloaded / timeout / unknown), never the provider's message. The message can
-- quote the request, and the request is the prompt.
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "outcome" text NOT NULL DEFAULT 'ok';
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "error_kind" text;

-- Error-rate-by-agent reads filter on instance_id + outcome and order by time.
CREATE INDEX IF NOT EXISTS "idx_ai_logs_instance_outcome"
  ON "ai_logs" ("instance_id", "outcome", "created_at");
