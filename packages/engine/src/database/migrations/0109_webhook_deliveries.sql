-- One row per Idempotency-Key a webhook sender presented, so an event the
-- sender redelivers after a timeout is acknowledged without running the
-- matcher and the conversation again. The key is stored as a SHA-256 digest;
-- the engine drops rows older than a day as it claims new keys.
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "event_source_id" uuid NOT NULL REFERENCES "event_sources"("id") ON DELETE CASCADE,
  "key_digest" varchar(64) NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("event_source_id", "key_digest")
);
